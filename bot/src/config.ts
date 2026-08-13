export interface Config {
  port: number;
  openwaUrl: string;
  openwaApiKey: string;
  openwaSessionName: string;
  webhookSecret: string;
  publicUrl: string;
  searchCacheTtlMs: number;
  stateTtlMs: number;
  anilistEndpoint: string;
  nekoBaseUrl: string;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(): Config {
  const openwaUrl = process.env.OPENWA_URL ?? 'http://localhost:2790';
  return {
    port: intEnv('BOT_PORT', 3001),
    openwaUrl,
    openwaApiKey: process.env.OPENWA_API_KEY ?? '',
    openwaSessionName: process.env.OPENWA_SESSION_NAME ?? 'momo',
    webhookSecret: process.env.WEBHOOK_SECRET ?? '',
    publicUrl: process.env.OPENWA_PUBLIC_URL ?? '',
    searchCacheTtlMs: intEnv('SEARCH_CACHE_TTL_MS', 5 * 60 * 1000),
    stateTtlMs: intEnv('BOT_STATE_TTL_MS', 10 * 60 * 1000),
    anilistEndpoint: process.env.ANILIST_ENDPOINT ?? 'https://graphql.anilist.co',
    nekoBaseUrl: process.env.NEKO_BASE_URL ?? 'https://mapper.nekostream.site/api/mal',
  };
}