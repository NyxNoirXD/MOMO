import type { AnimeMatch } from './anilist.js';
import type { NekoResult, NekoServer } from './nekostream.js';

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
  if (!range) {
    return { error: 'Send an *episode number* (e.g. `5`) or a *range* (e.g. `5-8`), or *cancel*.' };
  }
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
    `• *d <title> <episode>* - quick download, e.g. \`${p}d one piece 1087\` or \`${p}d one piece 1080-1090\``,
    '• Ranges like `5-8` work too (max 24 episodes per request)',
    '• Reply with numbers to walk through: pick -> episode/range -> sub/dub -> quality',
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
    const meta = [m.format, m.episodes ? `${m.episodes} eps` : undefined].filter(Boolean).join(' · ');
    return `${i + 1}. *${title}*${meta ? ` - _${meta}_` : ''}`;
  });
  return [`*Matches for "${query}":*`, '', ...lines, '', 'Reply with a *number* to choose, or *cancel*.'].join('\n');
}

export function episodePrompt(anime: AnimeMatch): string {
  const max = anime.episodes ? ` (max ${anime.episodes})` : '';
  return `*${anime.title}* - send the *episode number*${max}, a *range* like \`5-8\` (max ${MAX_EPISODES} eps), or *cancel*.`;
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

  if (episodes.length === 1) {
    const entry = fetched.find((f) => f.episode === episodes[0]);
    if (entry) {
      for (const server of entry.result.servers) {
        const parts: string[] = [];
        const url = pickLink(server, lang, quality);
        if (url) {
          parts.push(`*${lang}* ${quality}: ${url}`);
        }
        const extras = QUALITIES.filter((q) => q !== quality && pickLink(server, lang, q));
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
        const url = server ? pickLink(server, lang, quality) : undefined;
        if (url) {
          lines.push(`Ep ${episode}: ${url}`);
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

  if (failed.length) {
    out.push('_Failed:_', ...failed.map((f) => `Ep ${f.episode}: ${f.message}`), '');
  }
  out.push(this_linkNote());
  return out.join('\n');
}

function this_linkNote(): string {
  return '_Links can expire; if a link stops working, request the episode again._';
}