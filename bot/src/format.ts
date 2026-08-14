import type { AnimeMatch } from './anilist.js';
import type { NekoResult, NekoServer } from './nekostream.js';
import type { AdminStats } from './admin.js';

export const QUALITIES = ['360p', '720p', '1080p'] as const;
export type Quality = (typeof QUALITIES)[number];

export const LANGS = ['sub', 'dub'] as const;
export type Lang = (typeof LANGS)[number];

export const MAX_EPISODES = 24;

export function isQuality(input: string): input is Quality {
  const q = input.trim().toLowerCase();
  return QUALITIES.includes(q as Quality) || /^(360|720|1080)$/.test(q);
}

export function normalizeQuality(input: string): Quality {
  const q = input.trim().toLowerCase();
  return (q.includes('360') ? '360p' : q.includes('720') ? '720p' : '1080p') as Quality;
}

export function isLang(input: string): input is Lang {
  const l = input.trim().toLowerCase();
  return l === 'sub' || l === 'subbed' || l === 'dub' || l === 'dubbed' || l === 's' || l === 'd';
}

export function normalizeLang(input: string): Lang {
  return input.trim().toLowerCase().startsWith('d') ? 'dub' : 'sub';
}

export type EpisodeRange = { episodes: number[] } | { error: string };

/**
 * Parses an episode selection: a single number (`5`), a range (`5-8`), or a
 * comma-separated list mixing both (`1,3,5-7`). Results are deduped, sorted,
 * and capped at MAX_EPISODES.
 */
export function parseEpisodes(input: string): EpisodeRange {
  const text = input.trim();
  const single = text.match(/^\d+$/);
  if (single) {
    const ep = Number.parseInt(single[0], 10);
    if (ep < 1 || ep > 10000) {
      return { error: 'That episode number looks wrong. Send a number between 1 and 10000.' };
    }
    return { episodes: [ep] };
  }
  const range = text.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) {
    const start = Number.parseInt(range[1], 10);
    const end = Number.parseInt(range[2], 10);
    if (start < 1 || end > 10000 || end < start) {
      return { error: 'That range looks wrong. Use the format `5-8` (start must be smaller than end, between 1 and 10000).' };
    }
    const count = end - start + 1;
    if (count > MAX_EPISODES) {
      return { error: `Max *${MAX_EPISODES}* episodes per request (got ${count}). Try a smaller range.` };
    }
    const episodes: number[] = [];
    for (let ep = start; ep <= end; ep++) {
      episodes.push(ep);
    }
    return { episodes };
  }
  if (text.includes(',')) {
    const episodes: number[] = [];
    for (const token of text.split(',')) {
      const t = token.trim();
      if (!t) {
        continue;
      }
      const singleToken = t.match(/^(\d+)$/);
      if (singleToken) {
        const ep = Number.parseInt(singleToken[1], 10);
        if (ep < 1 || ep > 10000) {
          return { error: 'That episode number looks wrong. Send numbers between 1 and 10000.' };
        }
        episodes.push(ep);
        continue;
      }
      const rangeToken = t.match(/^(\d+)\s*-\s*(\d+)$/);
      if (rangeToken) {
        const start = Number.parseInt(rangeToken[1], 10);
        const end = Number.parseInt(rangeToken[2], 10);
        if (start < 1 || end > 10000 || end < start) {
          return { error: 'That range looks wrong. Use the format `5-8` (start must be smaller than end, between 1 and 10000).' };
        }
        for (let ep = start; ep <= end; ep++) {
          episodes.push(ep);
        }
        continue;
      }
      return { error: `Could not understand \`${t}\`. Send a number, a range like \`5-8\`, or a list like \`1,3,5-8\`.` };
    }
    const unique = [...new Set(episodes)].sort((a, b) => a - b);
    if (unique.length === 0) {
      return { error: 'Send an *episode number* (e.g. `5`), a *range* (e.g. `5-8`), or *cancel*.' };
    }
    if (unique.length > MAX_EPISODES) {
      return { error: `Max *${MAX_EPISODES}* episodes per request (got ${unique.length}). Try a smaller selection.` };
    }
    return { episodes: unique };
  }
  return { error: 'Send an *episode number* (e.g. `5`), a *range* (e.g. `5-8`), or *cancel*.' };
}

export function episodeLabel(episodes: number[]): string {
  if (episodes.length === 1) {
    return `Episode ${episodes[0]}`;
  }
  return `Episodes ${episodes[0]}-${episodes[episodes.length - 1]} (${episodes.length})`;
}

export function helpText(prefixes = '/!'): string {
  const p = prefixes.includes(' ') ? '' : prefixes;
  return [
    '*Momo - Anime Download Bot*',
    '',
    '_Commands:_',
    `• Send an *anime name* - search and pick${p ? ` (PM only)` : ''}`,
    `• *d <title> <episode>* - quick download, e.g. \`${p}d one piece 1087\`, \`${p}d one piece 1080-1090\` or \`${p}d one piece latest\``,
    '• Ranges like `5-8` and lists like `1,3,5-8` work too (max 24 episodes); *latest* grabs the newest episode',
    '• Reply with numbers to walk through: pick -> episode/range -> sub/dub -> quality',
    `• *info <anime>* - details (score, synopsis, studio) + straight to download`,
    `• *sub <anime>* - get pinged here when a new episode drops; *subs* lists, *unsub <n>* removes`,
    `• *pref* - set a default language/quality (e.g. \`${p}pref sub 720p\`) so you are not asked every time`,
    '• *cancel* - stop current search',
    '• *help* / *menu* - this message',
    '',
    `_In groups, prefix commands with one of: \`${p || 'none'}\`_`,
    'Works in DMs and groups.',
  ].join('\n');
}

export function searchList(query: string, results: AnimeMatch[]): string {
  const lines = results.map((m, i) => {
    const title = m.englishTitle && m.englishTitle !== m.title ? `${m.title} (${m.englishTitle})` : m.title;
    const meta = [
      m.format,
      m.year ? String(m.year) : undefined,
      m.episodes ? `${m.episodes} eps` : m.nextAiringEpisode ? 'airing' : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
    return `${i + 1}. *${title}*${meta ? ` - _${meta}_` : ''}`;
  });
  return [`*Matches for "${query}":*`, '', ...lines, '', 'Reply with a *number* to choose, or *cancel*.'].join('\n');
}

export function episodePrompt(anime: AnimeMatch): string {
  const max = anime.episodes ? ` (max ${anime.episodes})` : '';
  const latest = anime.nextAiringEpisode
    ? ` or *latest* (ep ${anime.nextAiringEpisode - 1})`
    : anime.episodes
      ? ` or *latest* (ep ${anime.episodes})`
      : ' or *latest*';
  return `*${anime.title}* - send the *episode number*${max}, a *range* like \`5-8\`, a *list* like \`1,3,5-8\` (max ${MAX_EPISODES} eps total)${latest}, or *cancel*.`;
}

export function langPrompt(anime: AnimeMatch, episodes: number[]): string {
  return [
    `*${anime.title}* - ${episodeLabel(episodes)}`,
    '',
    'Choose *language*:',
    '1. *sub*',
    '2. *dub*',
    '',
    'Reply *sub* or *dub* (or 1 or 2), or *cancel*.',
  ].join('\n');
}

export function qualityPrompt(anime: AnimeMatch, episodes: number[]): string {
  return [
    `*${anime.title}* - ${episodeLabel(episodes)}`,
    '',
    'Choose *quality*:',
    ...QUALITIES.map((q, i) => `${i + 1}. ${q}`),
    '',
    'Reply with a *number* or the quality (e.g. `720p`), or *cancel*.',
  ].join('\n');
}

export interface FetchedEpisode {
  episode: number;
  result: NekoResult;
}

function pickLink(
  server: NekoServer,
  lang: Lang,
  quality: Quality,
): string | undefined {
  return lang === 'sub' ? server.sub[quality] : server.dub?.[quality] ?? undefined;
}

/** Best available link at the requested quality or the nearest lower one. */
function pickLinkFallback(
  server: NekoServer,
  lang: Lang,
  requested: Quality,
): { url: string; used: Quality } | undefined {
  const reqIdx = QUALITIES.indexOf(requested);
  for (let i = reqIdx; i >= 0; i--) {
    const q = QUALITIES[i];
    const url = pickLink(server, lang, q);
    if (url) {
      return { url, used: q };
    }
  }
  return undefined;
}

export function linkCard(
  anime: AnimeMatch,
  episodes: number[],
  lang: Lang,
  quality: Quality,
  fetched: FetchedEpisode[],
  failed: Array<{ episode: number; message: string }>,
): string {
  const title = anime.englishTitle && anime.englishTitle !== anime.title ? `${anime.title} (${anime.englishTitle})` : anime.title;
  const label =
    episodes.length === 1 ? `Episode ${episodes[0]}` : `Episodes ${episodes[0]}-${episodes[episodes.length - 1]}`;
  const out: string[] = [`*${title}* - ${label} (${lang}, ${quality})`, ''];
  let fellBack = false;

  if (episodes.length === 1) {
    const entry = fetched.find((f) => f.episode === episodes[0]);
    if (entry) {
      for (const server of entry.result.servers) {
        const parts: string[] = [];
        const picked = pickLinkFallback(server, lang, quality);
        if (picked) {
          if (picked.used === quality) {
            parts.push(`*${lang}* ${quality}: ${picked.url}`);
          } else {
            fellBack = true;
            parts.push(`*${lang}* ${picked.used}: ${picked.url} _- ${quality} unavailable, fell back_`);
          }
        }
        const extras = QUALITIES.filter((q) => q !== quality && q !== picked?.used && pickLink(server, lang, q));
        if (extras.length) {
          parts.push(`_Other qualities: ${extras.join(', ')}_`);
        }
        if (parts.length) {
          out.push(`*${server.name}*`, ...parts, '');
        }
      }
    }
  } else {
    const serverNames = new Set<string>();
    for (const f of fetched) {
      for (const server of f.result.servers) {
        serverNames.add(server.name);
      }
    }
    for (const name of serverNames) {
      const lines: string[] = [];
      const missing: number[] = [];
      for (const episode of episodes) {
        const entry = fetched.find((f) => f.episode === episode);
        const server = entry?.result.servers.find((s) => s.name === name);
        const picked = server ? pickLinkFallback(server, lang, quality) : undefined;
        if (picked) {
          lines.push(picked.used === quality ? `Ep ${episode}: ${picked.url}` : `Ep ${episode}: ${picked.url} (${picked.used})`);
          if (picked.used !== quality) {
            fellBack = true;
          }
        } else if (entry) {
          missing.push(episode);
        }
      }
      if (lines.length) {
        out.push(`*${name}*`, ...lines);
        if (missing.length) {
          out.push(`_Ep ${missing.join(', ')}: no ${lang} ${quality} on this server_`);
        }
        out.push('');
      }
    }
  }

  if (fellBack) {
    out.splice(1, 0, `_Note: ${quality} unavailable for some links - used the nearest lower quality._`, '');
  }
  if (failed.length) {
    out.push('_Failed:_', ...failed.map((f) => `Ep ${f.episode}: ${f.message}`), '');
  }
  out.push(this_linkNote());
  return out.join('\n');
}

function this_linkNote(): string {
  return '_Links can expire; if a link stops working, request the episode again._';
}

export function statusText(
  session: {
    name: string;
    status: string;
    phone?: string | null;
    pushName?: string | null;
    connectedAt?: string | null;
    lastActive?: string | null;
  } | null,
): string {
  if (!session) {
    return '*Session:* not found.';
  }
  const rows = [
    `*Session:* ${session.name}`,
    `*Status:* ${session.status}`,
    session.phone ? `*Phone:* ${session.phone}` : undefined,
    session.pushName ? `*Push name:* ${session.pushName}` : undefined,
    session.connectedAt ? `*Connected:* ${new Date(session.connectedAt).toISOString()}` : undefined,
    session.lastActive ? `*Last active:* ${new Date(session.lastActive).toISOString()}` : undefined,
  ].filter(Boolean);
  return rows.join('\n');
}

export function statsText(stats: AdminStats): string {
  const lines = (entries: Array<{ key: string; count: number }>) =>
    entries.length
      ? entries.map((e) => `• ${e.key} - ${e.count}`)
      : ['• none yet'];
  return [
    '*Bot stats:*',
    `*Messages seen:* ${stats.messagesSeen}`,
    `*Known chats:* ${stats.knownChats}`,
    '',
    '_Top searches:_',
    ...lines(stats.searches),
    '',
    '_Top downloads:_',
    ...lines(stats.downloads),
    '',
    '_Errors:_',
    ...lines(stats.errors),
  ].join('\n');
}

export function broadcastResult(sent: number, max: number, total: number): string {
  return `Broadcast sent to ${sent} chat(s)${sent < total ? ` (capped at ${max}, ${total - sent} skipped)` : ''}.`;
}

export function infoCard(anime: AnimeMatch): string {
  const title = anime.englishTitle && anime.englishTitle !== anime.title ? `${anime.title} (${anime.englishTitle})` : anime.title;
  const meta = [
    anime.format,
    anime.year ? String(anime.year) : undefined,
    anime.status ? anime.status.replaceAll('_', ' ').toLowerCase() : undefined,
    anime.episodes ? `${anime.episodes} eps` : anime.nextAiringEpisode ? 'airing' : undefined,
    anime.duration ? `${anime.duration} min/ep` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  const score = anime.meanScore != null ? `⭐ ${anime.meanScore}/100` : undefined;
  const genres = anime.genres?.length ? `_Genres:_ ${anime.genres.join(', ')}` : undefined;
  const studios = anime.studios?.length ? `_Studio:_ ${anime.studios.join(', ')}` : undefined;
  const synopsis = anime.synopsis
    ? anime.synopsis.length > 280
      ? `${anime.synopsis.slice(0, 277).trimEnd()}...`
      : anime.synopsis
    : undefined;
  const out: Array<string | undefined> = [`*${title}*`, meta ? `_${meta}_` : undefined, score, genres, studios];
  if (synopsis) {
    out.push('', synopsis);
  }
  out.push('', 'Reply with an *episode number* (or *latest*) to download.');
  return out.filter((l) => l !== undefined).join('\n');
}

export function prefText(pref: { lang?: Lang; quality?: Quality } | undefined): string {
  return [
    '*Your preferences:*',
    `Language: ${pref?.lang ? `*${pref.lang}*` : '_not set_ (asked each time)'}`,
    `Quality: ${pref?.quality ? `*${pref.quality}*` : '_not set_ (asked each time)'}`,
    '',
    'Set with: *pref sub*, *pref 720p*, or *pref sub 720p*. Clear with *pref none*.',
  ].join('\n');
}

export function subConfirm(title: string, latest: number | null): string {
  const base = `Subscribed to *${title}*. I'll ping this chat when a new episode drops.`;
  return latest === null ? `${base}\n_No airing data yet - I'll sync the baseline on the next check._` : `${base}\n_Latest known: episode ${latest}._`;
}

export function subsList(entries: Array<{ title: string; lastEpisode: number | null }>): string {
  if (entries.length === 0) {
    return 'No subscriptions for this chat yet. Use *sub <anime>* to get alerted about new episodes.';
  }
  return [
    '*Subscriptions for this chat:*',
    ...entries.map((e, i) => `${i + 1}. *${e.title}*${e.lastEpisode != null ? ` (latest known: ${e.lastEpisode})` : ''}`),
    '',
    'Remove one with *unsub <number>*.',
  ].join('\n');
}

export function unsubConfirm(title: string): string {
  return `Removed *${title}* from this chat's subscriptions.`;
}