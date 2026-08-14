import fs from 'node:fs';
import path from 'node:path';
import type { AniListClient } from './anilist.js';
import type { OpenWaClient } from './openwaClient.js';

export interface Subscription {
  chatId: string;
  malId: number;
  title: string;
  /** Last episode the subscriber has been alerted about (null = not known yet). */
  lastEpisode: number | null;
}

interface SubsFile {
  subscriptions: Subscription[];
}

/**
 * Per-chat anime subscriptions, persisted to JSON (default
 * /app/data/subs.json). The poller checks AniList airing data and pings chats
 * when a subscribed anime gets a new episode.
 */
export class SubscriptionStore {
  private subs: Subscription[] = [];

  constructor(private readonly dataFile: string) {
    try {
      const raw = fs.readFileSync(dataFile, 'utf8');
      const data = JSON.parse(raw) as SubsFile;
      this.subs = data.subscriptions ?? [];
    } catch {
      // First boot or unreadable file - start empty.
    }
  }

  /** Add or refresh a subscription for a chat + anime. */
  upsert(sub: Subscription): void {
    const existing = this.subs.find((s) => s.chatId === sub.chatId && s.malId === sub.malId);
    if (existing) {
      existing.title = sub.title;
      existing.lastEpisode = sub.lastEpisode;
    } else {
      this.subs.push(sub);
    }
    this.save();
  }

  listForChat(chatId: string): Subscription[] {
    return this.subs.filter((s) => s.chatId === chatId);
  }

  all(): Subscription[] {
    return this.subs;
  }

  remove(sub: Subscription): void {
    this.subs = this.subs.filter(
      (s) => !(s.chatId === sub.chatId && s.malId === sub.malId),
    );
    this.save();
  }

  setLast(sub: Subscription, episode: number): void {
    const found = this.subs.find((s) => s.chatId === sub.chatId && s.malId === sub.malId);
    if (found) {
      found.lastEpisode = episode;
      this.save();
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
      fs.writeFileSync(this.dataFile, JSON.stringify({ subscriptions: this.subs } satisfies SubsFile, null, 2));
    } catch {
      // Persistence is best-effort; subscriptions still work in memory.
    }
  }
}

export class SubscriptionPoller {
  constructor(
    private readonly openwa: OpenWaClient,
    private readonly anilist: AniListClient,
    private readonly store: SubscriptionStore,
    private readonly log: (msg: string) => void,
  ) {}

  async check(): Promise<void> {
    const subs = this.store.all();
    if (subs.length === 0) {
      return;
    }
    const byMal = new Map<number, Subscription[]>();
    for (const sub of subs) {
      const list = byMal.get(sub.malId) ?? [];
      list.push(sub);
      byMal.set(sub.malId, list);
    }
    for (const [malId, chatSubs] of byMal) {
      let info;
      try {
        info = await this.anilist.airingInfo(malId);
      } catch (err) {
        this.log(`sub poller: airing lookup failed for #${malId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const latest = info?.nextAiringEpisode ? info.nextAiringEpisode - 1 : info?.episodes ?? null;
      if (latest === null) {
        continue; // no airing data yet - check again next round
      }
      for (const sub of chatSubs) {
        if (sub.lastEpisode === null) {
          // First contact: baseline only, no alert for the backlog.
          this.store.setLast(sub, latest);
          continue;
        }
        if (latest > sub.lastEpisode) {
          try {
            await this.openwa.sendText(
              sub.chatId,
              [
                '*New episode alert*',
                `*${sub.title}* - Episode ${latest} is out!`,
                `Send: *d ${sub.title} ${latest}*`,
              ].join('\n'),
            );
            this.log(`sub poller: alerted ${sub.chatId} about ${sub.title} ep ${latest}`);
          } catch (err) {
            this.log(`sub poller: alert to ${sub.chatId} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          this.store.setLast(sub, latest);
        }
      }
    }
  }
}
