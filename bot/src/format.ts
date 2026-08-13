import type { AnimeMatch } from './anilist.js';
import type { NekoResult } from './nekostream.js';

export const QUALITIES = ['360p', '720p', '1080p'] as const;
export type Quality = (typeof QUALITIES)[number];

export function isQuality(input: string): input is Quality {
  const q = input.trim().toLowerCase();
  return QUALITIES.includes(q as Quality) || /^(360|720|1080)$/.test(q);
}

export function normalizeQuality(input: string): Quality {
  const q = input.trim().toLowerCase();
  return (q.includes('360') ? '360p' : q.includes('720') ? '720p' : '1080p') as Quality;
}

export function helpText(prefixes = '/!'): string {
  const p = prefixes.includes(' ') ? '' : prefixes;
  return [
    '*Momo - Anime Download Bot*',
    '',
    '_Commands:_',
    `• Send an *anime name* - search and pick${p ? ` (PM only)` : ''}`,
    `• *d <title> <episode>* - quick download, e.g. \`${p}d one piece 1087\``,
    '• Reply with numbers to walk through: pick -> episode -> quality',
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
  return `*${anime.title}* - send the *episode number*${max}, or *cancel*.`;
}

export function qualityPrompt(anime: AnimeMatch, episode: number): string {
  return [
    `*${anime.title}* - Episode ${episode}`,
    '',
    'Choose *quality*:',
    ...QUALITIES.map((q, i) => `${i + 1}. ${q}`),
    '',
    'Reply with a *number* or the quality (e.g. `720p`), or *cancel*.',
  ].join('\n');
}

export function linkCard(
  anime: AnimeMatch,
  episode: number,
  quality: Quality,
  result: NekoResult,
): string {
  const title = anime.englishTitle && anime.englishTitle !== anime.title ? `${anime.title} (${anime.englishTitle})` : anime.title;
  const blocks: string[] = [];
  for (const server of result.servers) {
    const parts: string[] = [];
    if (server.sub[quality]) {
      parts.push(`*Sub* ${quality}: ${server.sub[quality]}`);
    }
    if (server.dub?.[quality]) {
      parts.push(`*Dub* ${quality}: ${server.dub[quality]}`);
    }
    const extras = QUALITIES.filter((q) => q !== quality && (server.sub[q] || server.dub?.[q]));
    if (extras.length) {
      parts.push(`_Other qualities: ${extras.join(', ')}_`);
    }
    if (parts.length) {
      blocks.push(`*${server.name}*`, ...parts, '');
    }
  }
  return [`*${title}* - Episode ${episode} (${quality})`, '', ...blocks, this_linkNote(), ''].join(
    '\n',
  );
}

function this_linkNote(): string {
  return '_Links can expire; if a link stops working, request the episode again._';
}