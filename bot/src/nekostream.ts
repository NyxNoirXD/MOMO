export interface NekoServer {
  name: string;
  sub: Record<string, string>;
  dub: Record<string, string> | null;
}

export interface NekoResult {
  servers: NekoServer[];
  servedFrom: string;
  cacheExpiresIn?: string;
}

export class NekoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NekoError';
  }
}

const BASE_URL = 'https://mapper.nekostream.site/api/mal';
const KNOWN_SERVERS = ['Kiwi', 'gogoanime', 'anivibe'];

export class NekoStreamClient {
  constructor(private readonly baseUrl = BASE_URL) {}

  async fetch(malId: number, episode: number): Promise<NekoResult> {
    const timestamp = Math.floor(Date.now() / 1000);
    const url = `${this.baseUrl}/${malId}/${episode}/${timestamp}`;
    const res = await fetch(url, {
      headers: { 'Accept-Encoding': 'gzip', Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 404) {
      throw new NekoError(`Episode ${episode} not found (MAL #${malId}).`);
    }
    if (!res.ok) {
      throw new NekoError(`Download API error ${res.status} for MAL #${malId} ep ${episode}. Try again in a minute.`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new NekoError('Download API returned an unreadable response. Try again.');
    }
    return this.parse(json, malId, episode);
  }

  private parse(raw: unknown, malId: number, episode: number): NekoResult {
    if (typeof raw !== 'object' || raw === null) {
      throw new NekoError('Download API returned an empty response.');
    }
    const record = raw as Record<string, unknown>;
    const status = (record.status ?? {}) as Record<string, unknown>;
    const servers: NekoServer[] = [];
    const names = KNOWN_SERVERS.filter((n) => record[n]);
    for (const name of names) {
      const server = record[name] as Record<string, unknown>;
      const sub = this.extractQualityMap(server.sub);
      const dub = server.dub ? this.extractQualityMap(server.dub) : null;
      if (sub || dub) {
        servers.push({ name, sub, dub });
      }
    }
    if (servers.length === 0) {
      throw new NekoError(
        `No download links for MAL #${malId} ep ${episode} on any server. It may not be uploaded yet.`,
      );
    }
    return {
      servers,
      servedFrom: String(status.serves_from ?? 'unknown'),
      cacheExpiresIn: status.cache_expires_in ? String(status.cache_expires_in) : undefined,
    };
  }

  private extractQualityMap(raw: unknown): Record<string, string> {
    if (typeof raw !== 'object' || raw === null) {
      return {};
    }
    const section = raw as Record<string, unknown>;
    const download = (section.download ?? {}) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [quality, link] of Object.entries(download)) {
      if (typeof link === 'string' && /^https?:\/\//.test(link)) {
        out[quality] = link;
      }
    }
    return out;
  }
}