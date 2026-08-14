import type { AniListClient, AnimeMatch } from './anilist.js';
import type { NekoResult, NekoStreamClient } from './nekostream.js';
import { NekoError } from './nekostream.js';
import {
  LANGS,
  Lang,
  QUALITIES,
  Quality,
  EpisodeRange,
  episodeLabel,
  episodePrompt,
  helpText,
  isLang,
  isQuality,
  langPrompt,
  linkCard,
  normalizeLang,
  normalizeQuality,
  parseEpisodes,
  qualityPrompt,
  searchList,
} from './format.js';

type Step = 'idle' | 'awaiting_pick' | 'awaiting_episode' | 'awaiting_lang' | 'awaiting_quality';

/** Resolved episode numbers, or the 'latest' keyword (resolved once the anime is known). */
type EpisodeSpec = number[] | 'latest';

interface FlowState {
  step: Step;
  query: string;
  results: AnimeMatch[];
  anime?: AnimeMatch;
  episodes?: EpisodeSpec;
  lang?: Lang;
  updatedAt: number;
}

export interface Incoming {
  chatId: string;
  body: string;
  isGroup: boolean;
  /** Group sender JID for group messages (used to scope flow state per user). */
  author?: string;
}

export interface BotReply {
  text: string;
  /** Optional cover image to attach to the reply. */
  imageUrl?: string;
}

export class BotBrain {
  private states = new Map<string, FlowState>();

  private readonly prefixRe: RegExp;
  private readonly prefixes: string;

  constructor(
    private readonly anilist: AniListClient,
    private readonly neko: NekoStreamClient,
    private readonly stateTtlMs: number,
    groupCommandPrefixes = '/!',
  ) {
    this.prefixes = groupCommandPrefixes;
    const unique = [...new Set(groupCommandPrefixes)];
    this.prefixRe = new RegExp(`^[${unique.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')}]+`);
  }

  async handle(msg: Incoming): Promise<BotReply | null> {
    const raw = msg.body.trim();
    if (!raw) {
      return null;
    }
    // In groups, scope the flow to the SENDER: otherwise any member could
    // advance (or hijack) another member's active download by replying "1".
    const stateKey = msg.isGroup && msg.author ? `${msg.chatId}:${msg.author}` : msg.chatId;
    this.prune(stateKey);
    const state = this.states.get(stateKey);

    const hasPrefix = this.prefixRe.test(raw);
    const stripped = raw.replace(this.prefixRe, '');
    const lower = stripped.toLowerCase();

    // Groups: without a command prefix, only advance an already-active flow.
    // Everything else is ignored.
    if (msg.isGroup && !hasPrefix) {
      if (state && state.step !== 'idle' && isAdvanceInput(state, raw)) {
        return this.advance(stateKey, state, raw);
      }
      return null;
    }

    if (lower === 'help' || lower === 'menu' || lower === 'start') {
      return { text: helpText(this.prefixes) };
    }
    if (lower === 'cancel' || lower === 'stop' || lower === 'exit') {
      this.states.delete(stateKey);
      return { text: 'Cancelled. Send an anime name to start over, or *help*.' };
    }

    const quick = parseQuick(stripped);
    if (quick) {
      if (quick.error) {
        return { text: quick.error };
      }
      return this.runSearch(stateKey, quick.query, quick.episodes);
    }

    if (state && state.step !== 'idle') {
      if (isAdvanceInput(state, raw)) {
        return this.advance(stateKey, state, raw);
      }
      if (msg.isGroup) {
        return null;
      }
      // DM mid-flow: step-shaped tokens at the wrong step get a nudge, anything
      // else (e.g. a new anime name) restarts the flow as a fresh search.
      if (/^\d+$/.test(raw) || /^\d+\s*-\s*\d+$/.test(raw) || isLang(raw) || isQuality(raw)) {
        return this.advance(stateKey, state, raw);
      }
      return this.runSearch(stateKey, raw, undefined);
    }

    if (msg.isGroup) {
      return null;
    }

    return this.runSearch(stateKey, raw, undefined);
  }

  private async runSearch(chatId: string, query: string, spec: EpisodeSpec | undefined): Promise<BotReply> {
    let results: AnimeMatch[];
    try {
      results = await this.anilist.search(query);
    } catch (err) {
      return { text: `Search failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (results.length === 0) {
      this.states.delete(chatId);
      return { text: `No anime found for *"${query}"*. Try a different name, or *help*.` };
    }
    if (results.length === 1) {
      const anime = results[0];
      if (spec !== undefined) {
        const resolved = resolveEpisodes(spec, anime);
        if ('error' in resolved) {
          return { text: resolved.error };
        }
        this.states.set(chatId, { step: 'awaiting_lang', query, results, anime, episodes: resolved.episodes, updatedAt: Date.now() });
        return { text: langPrompt(anime, resolved.episodes) };
      }
      this.states.set(chatId, { step: 'awaiting_episode', query, results, anime, updatedAt: Date.now() });
      return { text: episodePrompt(anime) };
    }
    this.states.set(chatId, { step: 'awaiting_pick', query, results, episodes: spec, updatedAt: Date.now() });
    return { text: searchList(query, results) };
  }

  private async advance(chatId: string, state: FlowState, raw: string): Promise<BotReply> {
    if (state.step === 'awaiting_pick') {
      const number = Number.parseInt(raw, 10);
      if (!/^\d+$/.test(raw) || !Number.isFinite(number)) {
        return { text: `Pick a number between *1* and *${state.results.length}*, or *cancel*.` };
      }
      const anime = state.results[number - 1];
      if (!anime) {
        return {
          text: `Pick a number between *1* and *${state.results.length}*, or *cancel*.`,
        };
      }
      if (state.episodes !== undefined) {
        const resolved = resolveEpisodes(state.episodes, anime);
        if ('error' in resolved) {
          return { text: resolved.error };
        }
        this.states.set(chatId, { ...state, step: 'awaiting_lang', anime, episodes: resolved.episodes, updatedAt: Date.now() });
        return { text: langPrompt(anime, resolved.episodes) };
      }
      this.states.set(chatId, { ...state, step: 'awaiting_episode', anime, updatedAt: Date.now() });
      return { text: episodePrompt(anime) };
    }
    if (state.step === 'awaiting_episode') {
      const parsed = /^(latest|last|newest)$/i.test(raw)
        ? resolveEpisodes('latest', state.anime!)
        : parseEpisodes(raw);
      if ('error' in parsed) {
        return { text: parsed.error };
      }
      this.states.set(chatId, { ...state, step: 'awaiting_lang', episodes: parsed.episodes, updatedAt: Date.now() });
      return { text: langPrompt(state.anime!, parsed.episodes) };
    }
    if (state.step === 'awaiting_lang') {
      const number = Number.parseInt(raw, 10);
      const lang = isLang(raw) ? normalizeLang(raw) : /^[12]$/.test(raw) && LANGS[number - 1];
      if (!lang) {
        return { text: 'Reply *sub* or *dub* (or 1 or 2), or *cancel*.' };
      }
      this.states.set(chatId, { ...state, step: 'awaiting_quality', lang, updatedAt: Date.now() });
      const episodes = state.episodes;
      return { text: qualityPrompt(state.anime!, Array.isArray(episodes) ? episodes : []) };
    }
    if (state.step === 'awaiting_quality') {
      const number = Number.parseInt(raw, 10);
      const quality = isQuality(raw)
        ? normalizeQuality(raw)
        : /^[123]$/.test(raw)
          ? QUALITIES[number - 1]
          : undefined;
      if (!quality) {
        return { text: 'Choose a *quality*: 360p, 720p or 1080p, or *cancel*.' };
      }
      return this.finish(chatId, state, quality);
    }
    this.states.delete(chatId);
    return { text: 'What?' }; // unreachable: advance() is only called with a live non-idle state
  }

  private async finish(chatId: string, state: FlowState, quality: Quality): Promise<BotReply> {
    const anime = state.anime!;
    const episodes = state.episodes;
    if (!Array.isArray(episodes)) {
      return { text: 'What?' }; // unreachable: awaiting_quality always holds resolved episodes
    }
    const lang = state.lang!;
    this.states.delete(chatId);
    const fetched: Array<{ episode: number; result: NekoResult }> = [];
    const failed: Array<{ episode: number; message: string }> = [];
    // Sequential on purpose: a 24-episode burst against the API at once is both
    // slower for us and the exact spam-shaped pattern we want to avoid.
    for (const episode of episodes) {
      try {
        fetched.push({ episode, result: await this.neko.fetch(anime.malId, episode) });
      } catch (err) {
        const message =
          err instanceof NekoError ? err.message : `Download API error: ${err instanceof Error ? err.message : String(err)}`;
        failed.push({ episode, message });
      }
    }
    if (fetched.length === 0) {
      return {
        text: [
          `No links for ${episodeLabel(episodes)} (${lang}, ${quality}).`,
          '',
          ...failed.map((f) => `Ep ${f.episode}: ${f.message}`),
          '',
          'Send *cancel* or start over.',
        ].join('\n'),
      };
    }
    return { text: linkCard(anime, episodes, lang, quality, fetched, failed), imageUrl: anime.coverImage };
  }

  private prune(chatId: string): void {
    const now = Date.now();
    if (this.states.size > 1000) {
      for (const [key, state] of this.states) {
        if (now - state.updatedAt > this.stateTtlMs) {
          this.states.delete(key);
        }
      }
      return;
    }
    const state = this.states.get(chatId);
    if (state && now - state.updatedAt > this.stateTtlMs) {
      this.states.delete(chatId);
    }
  }
}

interface QuickCommand {
  query: string;
  episodes?: EpisodeSpec;
  error?: string;
}

function parseQuick(text: string): QuickCommand | null {
  const m = text.match(/^\/?d(?:ownload)?\s+(.+)$/i);
  if (!m) {
    return null;
  }
  const rest = m[1].trim();
  const withEp =
    rest.match(/^(.*?)\s+ep(?:isode)?\.?\s+([\d\s-]+|latest|last|newest)$/i) ??
    rest.match(/^(.*?)\s+([\d\s-]+|latest|last|newest)$/i);
  if (withEp) {
    const query = withEp[1].trim();
    if (!query) {
      return null;
    }
    const token = withEp[2].trim();
    if (/^(latest|last|newest)$/i.test(token)) {
      return { query, episodes: 'latest' };
    }
    const parsed = parseEpisodes(token);
    if ('error' in parsed) {
      return { query, error: parsed.error };
    }
    return { query, episodes: parsed.episodes };
  }
  return { query: rest };
}

function resolveEpisodes(spec: EpisodeSpec, anime: AnimeMatch): EpisodeRange {
  if (spec === 'latest') {
    const latest =
      anime.nextAiringEpisode && anime.nextAiringEpisode > 1
        ? anime.nextAiringEpisode - 1
        : anime.episodes;
    if (!latest || latest < 1) {
      return { error: `I don't know the latest episode for *${anime.title}*. Send a number or a range.` };
    }
    return { episodes: [latest] };
  }
  return { episodes: spec };
}

function isAdvanceInput(state: FlowState, raw: string): boolean {
  const t = raw.trim();
  if (state.step === 'awaiting_pick') {
    return /^\d+$/.test(t);
  }
  if (state.step === 'awaiting_episode') {
    return /^\d+$/.test(t) || /^\d+\s*-\s*\d+$/.test(t) || /^(latest|last|newest)$/i.test(t);
  }
  if (state.step === 'awaiting_lang') {
    return isLang(t) || /^[12]$/.test(t);
  }
  if (state.step === 'awaiting_quality') {
    return isQuality(t) || /^[123]$/.test(t);
  }
  return false;
}