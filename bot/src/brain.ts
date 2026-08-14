import type { AniListClient, AnimeMatch } from './anilist.js';
import type { NekoResult, NekoStreamClient } from './nekostream.js';
import { NekoError } from './nekostream.js';
import type { AdminService } from './admin.js';
import type { OpenWaClient } from './openwaClient.js';
import type { UserPrefs } from './prefs.js';
import type { SubscriptionStore } from './subs.js';
import {
  LANGS,
  Lang,
  QUALITIES,
  Quality,
  EpisodeRange,
  broadcastResult,
  episodeLabel,
  episodePrompt,
  helpText,
  infoCard,
  isLang,
  isQuality,
  langPrompt,
  linkCard,
  normalizeLang,
  normalizeQuality,
  parseEpisodes,
  prefText,
  qualityPrompt,
  searchList,
  statsText,
  statusText,
  subConfirm,
  subsList,
  unsubConfirm,
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
  /** True when a `sub <title>` search is awaiting its pick. */
  subscribe?: boolean;
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
  /** Optional inline image (base64, e.g. the WhatsApp link QR). */
  imageData?: { base64: string; mimetype: string };
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
    private readonly admin?: AdminService,
    private readonly openwa?: OpenWaClient,
    private readonly reloadWebhook?: () => Promise<string>,
    private readonly prefs?: UserPrefs,
    private readonly subs?: SubscriptionStore,
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
    const senderJid = msg.author ?? msg.chatId;
    this.admin?.recordMessage();
    this.admin?.recordChat(msg.chatId);
    // Access control first: banned chats/users are silently ignored, and in
    // allowlist mode only allowlisted users (and admins) get any reply.
    if (this.admin?.isBannedChat(msg.chatId, senderJid)) {
      return null;
    }
    if (this.admin && !this.admin.gateAllows(senderJid)) {
      return null;
    }
    // Admin commands: recognized for admins only, in DM and groups (no prefix
    // needed), and never shown in help. Non-admins fall through to the normal
    // flow - the admin-only commands are not special to them.
    if (this.admin?.isAdmin(senderJid)) {
      const adminReply = await this.handleAdmin(raw.replace(this.prefixRe, ''));
      if (adminReply) {
        return adminReply;
      }
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
        return this.advance(stateKey, state, raw, senderJid);
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

    const prefCmd = parsePref(stripped);
    if (prefCmd) {
      if (!this.prefs) {
        return { text: 'Preferences unavailable.' };
      }
      if (prefCmd.clear) {
        this.prefs.set(senderJid, {});
        return { text: 'Cleared your preferences.' };
      }
      this.prefs.set(senderJid, prefCmd.patch);
      return { text: prefText(this.prefs.get(senderJid)) };
    }

    const infoMatch = stripped.match(/^info\s+(.+)$/i);
    if (infoMatch) {
      return this.runInfo(stateKey, infoMatch[1].trim());
    }

    const subMatch = stripped.match(/^sub\s+(.+)$/i);
    if (subMatch) {
      if (!this.subs) {
        return { text: 'Subscriptions unavailable.' };
      }
      return this.runSearch(stateKey, subMatch[1].trim(), undefined, senderJid, { subscribe: true });
    }
    if (lower === 'subs') {
      if (!this.subs) {
        return { text: 'Subscriptions unavailable.' };
      }
      return { text: subsList(this.subs.listForChat(msg.chatId)) };
    }
    const unsubMatch = stripped.match(/^unsub\s+(\d+)$/i);
    if (unsubMatch && this.subs) {
      const entries = this.subs.listForChat(msg.chatId);
      const index = Number.parseInt(unsubMatch[1], 10) - 1;
      const entry = entries[index];
      if (!entry) {
        return { text: `No subscription #${unsubMatch[1]}. Use *subs* to list them.` };
      }
      this.subs.remove(entry);
      return { text: unsubConfirm(entry.title) };
    }

    const quick = parseQuick(stripped);
    if (quick) {
      if (quick.error) {
        return { text: quick.error };
      }
      return this.runSearch(stateKey, quick.query, quick.episodes, senderJid);
    }

    if (state && state.step !== 'idle') {
      if (isAdvanceInput(state, raw)) {
        return this.advance(stateKey, state, raw, senderJid);
      }
      if (msg.isGroup) {
        return null;
      }
      // DM mid-flow: step-shaped tokens at the wrong step get a nudge, anything
      // else (e.g. a new anime name) restarts the flow as a fresh search.
      if (/^[\d\s,-]+$/.test(raw) || isLang(raw) || isQuality(raw)) {
        return this.advance(stateKey, state, raw, senderJid);
      }
      return this.runSearch(stateKey, raw, undefined, senderJid);
    }

    if (msg.isGroup) {
      return null;
    }

    return this.runSearch(stateKey, raw, undefined, senderJid);
  }

  private async handleAdmin(stripped: string): Promise<BotReply | null> {
    const lower = stripped.toLowerCase();
    if (lower === 'status' || lower === 'session') {
      if (!this.openwa) {
        return { text: 'Status unavailable (no OpenWA client wired).' };
      }
      try {
        return { text: statusText(await this.openwa.getSessionStatus()) };
      } catch (err) {
        return { text: `Status failed: ${errMsg(err)}` };
      }
    }
    if (lower === 'qr') {
      if (!this.openwa) {
        return { text: 'QR unavailable (no OpenWA client wired).' };
      }
      try {
        const qr = await this.openwa.getSessionQr();
        if (!qr?.qrCode) {
          return { text: 'No QR available - is the session already linked? Try *status*.' };
        }
        const m = qr.qrCode.match(/^data:image\/(png|jpeg);base64,(.+)$/);
        if (!m) {
          return { text: `Unexpected QR payload: ${qr.qrCode.slice(0, 120)}` };
        }
        return {
          text: `*Scan this QR* (WhatsApp > Linked Devices > Link a Device). Session status: ${qr.status}. It expires quickly.`,
          imageData: { base64: m[2], mimetype: `image/${m[1]}` },
        };
      } catch (err) {
        return { text: `QR failed: ${errMsg(err)}` };
      }
    }
    if (lower === 'reload') {
      if (!this.reloadWebhook) {
        return { text: 'Reload unavailable (no webhook callback wired).' };
      }
      try {
        return { text: `Webhook: ${await this.reloadWebhook()}` };
      } catch (err) {
        return { text: `Reload failed: ${errMsg(err)}` };
      }
    }
    const ban = stripped.match(/^ban\s+(\S+)$/);
    if (ban) {
      return { text: this.admin!.ban(ban[1]) };
    }
    const unban = stripped.match(/^unban\s+(\S+)$/);
    if (unban) {
      return { text: this.admin!.unban(unban[1]) };
    }
    const allow = stripped.match(/^allow\s+(\S+)$/);
    if (allow) {
      return { text: this.admin!.allow(allow[1]) };
    }
    const deny = stripped.match(/^deny\s+(\S+)$/);
    if (deny) {
      return { text: this.admin!.deny(deny[1]) };
    }
    if (lower === 'allowlist') {
      return { text: this.admin!.allowlistInfo() };
    }
    if (lower === 'stats') {
      return { text: statsText(this.admin!.stats()) };
    }
    if (lower === 'flush') {
      this.flush();
      return { text: 'Cleared all flow states and caches.' };
    }
    const broadcast = stripped.match(/^broadcast\s+(.+)$/);
    if (broadcast && this.admin && this.openwa) {
      const targets = this.admin.broadcastTargets();
      if (targets.length === 0) {
        return { text: 'No known chats to broadcast to yet.' };
      }
      let sent = 0;
      const failures: string[] = [];
      for (const target of targets) {
        try {
          await this.openwa.sendText(target, broadcast[1]);
          sent++;
        } catch (err) {
          failures.push(`${target}: ${errMsg(err)}`);
        }
      }
      const base = broadcastResult(sent, this.admin.broadcastCap(), targets.length);
      return {
        text: failures.length ? `${base}\n_Failures:_ ${failures.join('; ')}` : base,
      };
    }
    return null;
  }

  flush(): void {
    this.states.clear();
    this.anilist.flush();
  }

  private async runSearch(
    chatId: string,
    query: string,
    spec: EpisodeSpec | undefined,
    senderJid: string,
    opts: { subscribe?: boolean } = {},
  ): Promise<BotReply> {
    // Per-user throttle: admins and the subscription flow are exempt.
    if (!opts.subscribe && this.admin) {
      const wait = this.admin.allowRequest(senderJid);
      if (wait > 0) {
        return { text: `Slow down - one request per ${Math.ceil(this.admin.rateLimitSec())}s. Try again in ~${wait}s.` };
      }
    }
    this.admin?.recordSearch(query);
    let results: AnimeMatch[];
    try {
      results = await this.anilist.search(query);
    } catch (err) {
      this.admin?.recordError(errMsg(err));
      return { text: `Search failed: ${errMsg(err)}` };
    }
    if (results.length === 0) {
      this.states.delete(chatId);
      return { text: `No anime found for *"${query}"*. Try a different name, or *help*.` };
    }
    if (results.length === 1) {
      const anime = results[0];
      if (opts.subscribe) {
        return this.subscribeTo(chatId, anime);
      }
      if (spec !== undefined) {
        const resolved = resolveEpisodes(spec, anime);
        if ('error' in resolved) {
          return { text: resolved.error };
        }
        return this.episodeChosen(
          chatId,
          { step: 'awaiting_episode', query, results, anime, episodes: resolved.episodes, updatedAt: Date.now() },
          senderJid,
        );
      }
      this.states.set(chatId, { step: 'awaiting_episode', query, results, anime, updatedAt: Date.now() });
      return { text: episodePrompt(anime) };
    }
    this.states.set(chatId, { step: 'awaiting_pick', query, results, episodes: spec, subscribe: opts.subscribe || undefined, updatedAt: Date.now() });
    return { text: searchList(query, results) };
  }

  private async advance(chatId: string, state: FlowState, raw: string, senderJid: string): Promise<BotReply> {
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
      if (state.subscribe) {
        return this.subscribeTo(chatId, anime);
      }
      if (state.episodes !== undefined) {
        const resolved = resolveEpisodes(state.episodes, anime);
        if ('error' in resolved) {
          return { text: resolved.error };
        }
        return this.episodeChosen(
          chatId,
          { ...state, anime, episodes: resolved.episodes, updatedAt: Date.now() },
          senderJid,
        );
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
      return this.episodeChosen(chatId, { ...state, episodes: parsed.episodes, updatedAt: Date.now() }, senderJid);
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

  /**
   * Episodes are known; skip to the language/quality steps unless the user's
   * preferences already pin them down (then go straight to the final card).
   */
  private async episodeChosen(chatId: string, state: FlowState, senderJid: string): Promise<BotReply> {
    const anime = state.anime!;
    const episodes = Array.isArray(state.episodes) ? state.episodes : [];
    const pref = this.prefs?.get(senderJid);
    if (pref?.lang && pref.quality) {
      return this.finish(chatId, { ...state, lang: pref.lang }, pref.quality);
    }
    if (pref?.lang) {
      this.states.set(chatId, { ...state, step: 'awaiting_quality', lang: pref.lang, updatedAt: Date.now() });
      return { text: qualityPrompt(anime, episodes) };
    }
    this.states.set(chatId, { ...state, step: 'awaiting_lang', updatedAt: Date.now() });
    return { text: langPrompt(anime, episodes) };
  }

  private subscribeTo(chatId: string, anime: AnimeMatch): BotReply {
    if (!this.subs) {
      return { text: 'Subscriptions unavailable.' };
    }
    const latest = resolveEpisodes('latest', anime);
    const lastEpisode = !('error' in latest) ? latest.episodes[0] : null;
    this.subs.upsert({
      chatId,
      malId: anime.malId,
      title: anime.title,
      lastEpisode,
    });
    this.states.delete(chatId);
    return { text: subConfirm(anime.title, lastEpisode) };
  }

  private async runInfo(chatId: string, title: string): Promise<BotReply> {
    let results: AnimeMatch[];
    try {
      results = await this.anilist.search(title);
    } catch (err) {
      return { text: `Search failed: ${errMsg(err)}` };
    }
    const anime = results[0];
    if (!anime) {
      return { text: `No anime found for *"${title}"*. Try a different name, or *help*.` };
    }
    // One reply away from downloading: the next message is treated as the episode step.
    this.states.set(chatId, {
      step: 'awaiting_episode',
      query: title,
      results,
      anime,
      updatedAt: Date.now(),
    });
    return { text: infoCard(anime), imageUrl: anime.coverImage };
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
          err instanceof NekoError ? err.message : `Download API error: ${errMsg(err)}`;
        failed.push({ episode, message });
        this.admin?.recordError(message);
      }
    }
    if (fetched.length === 0) {
      this.admin?.recordError(`no links: ${anime.title} ${episodeLabel(episodes)}`);
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
    this.admin?.recordDownload(anime.title);
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
    rest.match(/^(.*?)\s+ep(?:isode)?\.?\s+([\d\s,-]+|latest|last|newest)$/i) ??
    rest.match(/^(.*?)\s+([\d\s,-]+|latest|last|newest)$/i);
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
    return /^[\d\s,-]+$/.test(t) || /^(latest|last|newest)$/i.test(t);
  }
  if (state.step === 'awaiting_lang') {
    return isLang(t) || /^[12]$/.test(t);
  }
  if (state.step === 'awaiting_quality') {
    return isQuality(t) || /^[123]$/.test(t);
  }
  return false;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface PrefCommand {
  patch: Partial<{ lang: Lang; quality: Quality }>;
  clear?: boolean;
}

function parsePref(text: string): PrefCommand | null {
  const m = text.match(/^pref(?:\s+(.+))?$/i);
  if (!m) {
    return null;
  }
  const rest = m[1]?.trim().toLowerCase() ?? '';
  if (!rest) {
    return { patch: {} }; // bare "pref" just shows the current values
  }
  if (rest === 'none' || rest === 'clear' || rest === 'reset') {
    return { patch: {}, clear: true };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length > 2) {
    return null;
  }
  const patch: PrefCommand['patch'] = {};
  for (const token of tokens) {
    if (isLang(token)) {
      patch.lang = normalizeLang(token);
    } else if (isQuality(token)) {
      patch.quality = normalizeQuality(token);
    } else {
      return null;
    }
  }
  return { patch };
}