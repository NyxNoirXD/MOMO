import type { AniListClient, AnimeMatch } from './anilist.js';
import type { NekoStreamClient } from './nekostream.js';
import { NekoError } from './nekostream.js';
import {
  QUALITIES,
  Quality,
  episodePrompt,
  helpText,
  isQuality,
  linkCard,
  normalizeQuality,
  qualityPrompt,
  searchList,
} from './format.js';

type Step = 'idle' | 'awaiting_pick' | 'awaiting_episode' | 'awaiting_quality';

interface FlowState {
  step: Step;
  query: string;
  results: AnimeMatch[];
  anime?: AnimeMatch;
  episode?: number;
  updatedAt: number;
}

export interface Incoming {
  chatId: string;
  body: string;
  isGroup: boolean;
}

export interface BotReply {
  text: string;
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
    this.prune(msg.chatId);
    const state = this.states.get(msg.chatId);

    const hasPrefix = this.prefixRe.test(raw);
    const stripped = raw.replace(this.prefixRe, '');
    const lower = stripped.toLowerCase();

    // Groups: without a command prefix, only advance an already-active flow
    // (numbers / quality replies). Everything else is ignored.
    if (msg.isGroup && !hasPrefix) {
      if (state && state.step !== 'idle') {
        if (/^\d+$/.test(raw)) {
          return this.advance(msg.chatId, state, Number.parseInt(raw, 10), raw);
        }
        if (state.step === 'awaiting_quality' && isQuality(raw)) {
          return this.finish(msg.chatId, state, normalizeQuality(raw));
        }
      }
      return null;
    }

    if (lower === 'help' || lower === 'menu' || lower === 'start') {
      return { text: helpText(this.prefixes) };
    }
    if (lower === 'cancel' || lower === 'stop' || lower === 'exit') {
      this.states.delete(msg.chatId);
      return { text: 'Cancelled. Send an anime name to start over, or *help*.' };
    }

    const quick = parseQuick(stripped);
    if (quick) {
      return this.runSearch(msg.chatId, quick.query, quick.episode);
    }

    if (state && state.step !== 'idle' && /^\d+$/.test(raw)) {
      return this.advance(msg.chatId, state, Number.parseInt(raw, 10), raw);
    }

    if (state && state.step === 'awaiting_quality' && isQuality(raw)) {
      return this.finish(msg.chatId, state, normalizeQuality(raw));
    }

    if (msg.isGroup) {
      return null;
    }

    return this.runSearch(msg.chatId, raw, undefined);
  }

  private async runSearch(chatId: string, query: string, episode: number | undefined): Promise<BotReply> {
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
      if (episode !== undefined) {
        this.states.set(chatId, { step: 'awaiting_quality', query, results, anime, episode, updatedAt: Date.now() });
        return { text: qualityPrompt(anime, episode) };
      }
      this.states.set(chatId, { step: 'awaiting_episode', query, results, anime, updatedAt: Date.now() });
      return { text: episodePrompt(anime) };
    }
    this.states.set(chatId, { step: 'awaiting_pick', query, results, episode, updatedAt: Date.now() });
    return { text: searchList(query, results) };
  }

  private async advance(chatId: string, state: FlowState, number: number, raw: string): Promise<BotReply> {
    if (state.step === 'awaiting_pick') {
      const anime = state.results[number - 1];
      if (!anime) {
        return {
          text: `Pick a number between *1* and *${state.results.length}*, or *cancel*.`,
        };
      }
      if (state.episode !== undefined) {
        this.states.set(chatId, { ...state, step: 'awaiting_quality', anime, episode: state.episode, updatedAt: Date.now() });
        return { text: qualityPrompt(anime, state.episode) };
      }
      this.states.set(chatId, { ...state, step: 'awaiting_episode', anime, updatedAt: Date.now() });
      return { text: episodePrompt(anime) };
    }
    if (state.step === 'awaiting_episode') {
      if (number < 1 || number > 10000) {
        return { text: 'That episode number looks wrong. Send a number between 1 and 10000.' };
      }
      this.states.set(chatId, { ...state, step: 'awaiting_quality', episode: number, updatedAt: Date.now() });
      return { text: qualityPrompt(state.anime!, number) };
    }
    if (state.step === 'awaiting_quality') {
      return this.finish(chatId, state, QUALITIES[number - 1] ?? normalizeQuality(raw));
    }
    this.states.delete(chatId);
    return { text: 'What?' }; // unreachable: advance() is only called with a live non-idle state
  }

  private async finish(chatId: string, state: FlowState, quality: Quality): Promise<BotReply> {
    const anime = state.anime!;
    const episode = state.episode!;
    this.states.delete(chatId);
    let result;
    try {
      result = await this.neko.fetch(anime.malId, episode);
    } catch (err) {
      const message = err instanceof NekoError ? err.message : `Download API error: ${err instanceof Error ? err.message : String(err)}`;
      return { text: `${message}\n\nSend *cancel* or start over.` };
    }
    return { text: linkCard(anime, episode, quality, result) };
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
  episode?: number;
}

function parseQuick(text: string): QuickCommand | null {
  const m = text.match(/^\/?d(?:ownload)?\s+(.+)$/i);
  if (!m) {
    return null;
  }
  const rest = m[1].trim();
  const withEp = rest.match(/^(.*?)\s+ep(?:isode)?\.?\s+(\d+)$/i) ?? rest.match(/^(.*?)\s+(\d+)$/);
  if (withEp) {
    const query = withEp[1].trim();
    if (!query) {
      return null;
    }
    return { query, episode: Number.parseInt(withEp[2], 10) };
  }
  return { query: rest };
}