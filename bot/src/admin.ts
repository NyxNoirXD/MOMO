import fs from 'node:fs';
import path from 'node:path';

export interface AdminStats {
  messagesSeen: number;
  searches: Array<{ key: string; count: number }>;
  downloads: Array<{ key: string; count: number }>;
  errors: Array<{ key: string; count: number }>;
  knownChats: number;
}

interface AdminDataFile {
  banned: string[];
  allowed: string[];
}

/**
 * Admin access control + usage counters. Ban/allow lists persist to a JSON
 * file (default /app/data/admin.json, which the rclone backup covers).
 */
export class AdminService {
  private banned = new Set<string>();
  private allowed = new Set<string>();
  private knownChats = new Set<string>();

  private messagesSeen = 0;
  private searches = new Map<string, number>();
  private downloads = new Map<string, number>();
  private errors = new Map<string, number>();
  private lastRequestAt = new Map<string, number>();

  constructor(
    private readonly adminJids: string[],
    private readonly allowlistEnabled: boolean,
    private readonly broadcastMax: number,
    private readonly dataFile: string,
    private readonly rateLimitMs = 0,
  ) {
    this.load();
  }

  isAdmin(jid: string): boolean {
    return this.adminJids.includes(normalizeJid(jid));
  }

  isBanned(jid: string): boolean {
    return this.banned.has(normalizeJid(jid));
  }

  isBannedChat(chatId: string, senderJid: string): boolean {
    return this.banned.has(normalizeJid(chatId)) || this.banned.has(normalizeJid(senderJid));
  }

  /** Allowlist mode: non-admins must be in the allowed set. */
  gateAllows(jid: string): boolean {
    if (this.isAdmin(jid)) {
      return true;
    }
    return !this.allowlistEnabled || this.allowed.has(normalizeJid(jid));
  }

  ban(jid: string): string {
    const j = normalizeJid(jid);
    if (this.adminJids.includes(j)) {
      return 'Nice try - you cannot ban an admin.';
    }
    this.banned.add(j);
    this.allowed.delete(j);
    this.save();
    return `Banned \`${j}\`. They are now ignored silently.`;
  }

  unban(jid: string): string {
    const j = normalizeJid(jid);
    this.banned.delete(j);
    this.save();
    return `Unbanned \`${j}\`.`;
  }

  allow(jid: string): string {
    const j = normalizeJid(jid);
    this.allowed.add(j);
    this.banned.delete(j);
    this.save();
    return `Allowlisted \`${j}\`.`;
  }

  deny(jid: string): string {
    const j = normalizeJid(jid);
    this.allowed.delete(j);
    this.save();
    return `Removed \`${j}\` from the allowlist.`;
  }

  allowlistInfo(): string {
    const mode = this.allowlistEnabled ? 'ENFORCED (only allowlisted users are answered)' : 'disabled (everyone answered)';
    const banned = [...this.banned].sort().join(', ') || 'none';
    const allowed = [...this.allowed].sort().join(', ') || 'none';
    return [
      `*Allowlist mode:* ${mode}`,
      '',
      `_Banned:_ ${banned}`,
      `_Allowlisted:_ ${allowed}`,
    ].join('\n');
  }

  recordMessage(): void {
    this.messagesSeen++;
  }

  recordChat(chatId: string): void {
    if (this.knownChats.size >= 500) {
      return;
    }
    this.knownChats.add(chatId);
  }

  recordSearch(query: string): void {
    this.searches.set(query, (this.searches.get(query) ?? 0) + 1);
  }

  recordDownload(title: string): void {
    this.downloads.set(title, (this.downloads.get(title) ?? 0) + 1);
  }

  recordError(message: string): void {
    const key = message.slice(0, 120);
    this.errors.set(key, (this.errors.get(key) ?? 0) + 1);
  }

  stats(): AdminStats {
    const top = (map: Map<string, number>, n: number) =>
      [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([key, count]) => ({ key, count }));
    return {
      messagesSeen: this.messagesSeen,
      searches: top(this.searches, 10),
      downloads: top(this.downloads, 10),
      errors: top(this.errors, 10),
      knownChats: this.knownChats.size,
    };
  }

  broadcastTargets(): string[] {
    return [...this.knownChats].slice(0, this.broadcastMax);
  }

  broadcastCap(): number {
    return this.broadcastMax;
  }

  /**
   * Per-user request throttle. Returns the seconds left until the next request
   * is allowed, or 0 if the request may proceed (and it is recorded).
   */
  allowRequest(jid: string): number {
    if (this.rateLimitMs <= 0) {
      return 0;
    }
    const key = normalizeJid(jid);
    const now = Date.now();
    const last = this.lastRequestAt.get(key);
    if (last !== undefined) {
      const waitMs = this.rateLimitMs - (now - last);
      if (waitMs > 0) {
        return Math.ceil(waitMs / 1000);
      }
    }
    this.lastRequestAt.set(key, now);
    if (this.lastRequestAt.size > 5000) {
      const oldest = this.lastRequestAt.keys().next().value;
      if (oldest !== undefined) {
        this.lastRequestAt.delete(oldest);
      }
    }
    return 0;
  }

  rateLimitSec(): number {
    return Math.ceil(this.rateLimitMs / 1000);
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.dataFile, 'utf8');
      const data = JSON.parse(raw) as AdminDataFile;
      this.banned = new Set(data.banned ?? []);
      this.allowed = new Set(data.allowed ?? []);
    } catch {
      // First boot or unreadable file - start empty.
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
      const data: AdminDataFile = { banned: [...this.banned], allowed: [...this.allowed] };
      fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2));
    } catch {
      // Persistence is best-effort (e.g. read-only FS); lists still work in memory.
    }
  }
}

export function normalizeJid(jid: string): string {
  return jid.trim().replace(/^\+/, '').replace(/@.*$/, '').replace(/\D/g, '');
}
