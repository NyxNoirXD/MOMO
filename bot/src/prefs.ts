import fs from 'node:fs';
import path from 'node:path';
import { normalizeJid } from './admin.js';
import type { Lang, Quality } from './format.js';

export interface UserPref {
  jid: string;
  lang?: Lang;
  quality?: Quality;
}

interface PrefsFile {
  users: UserPref[];
}

/**
 * Per-user default language/quality. Persisted to JSON (default
 * /app/data/prefs.json). When both are set the download flow skips those steps.
 */
export class UserPrefs {
  private users = new Map<string, UserPref>();

  constructor(private readonly dataFile: string) {
    try {
      const raw = fs.readFileSync(dataFile, 'utf8');
      const data = JSON.parse(raw) as PrefsFile;
      for (const user of data.users ?? []) {
        this.users.set(user.jid, user);
      }
    } catch {
      // First boot or unreadable file - start empty.
    }
  }

  get(jid: string): UserPref | undefined {
    return this.users.get(normalizeJid(jid));
  }

  set(jid: string, patch: { lang?: Lang; quality?: Quality }): UserPref {
    const key = normalizeJid(jid);
    const current = this.users.get(key) ?? { jid: key };
    const next: UserPref = { ...current, ...patch };
    this.users.set(key, next);
    this.save();
    return next;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
      fs.writeFileSync(this.dataFile, JSON.stringify({ users: [...this.users.values()] } satisfies PrefsFile, null, 2));
    } catch {
      // Persistence is best-effort; prefs still work in memory.
    }
  }
}
