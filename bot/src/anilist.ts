export interface AnimeMatch {
  malId: number;
  anilistId: number;
  title: string;
  englishTitle?: string;
  episodes?: number;
  format: string;
  /** Release year of the first episode (startDate.year), if known. */
  year?: number;
  /** nextAiringEpisode.episode if the show is currently airing. */
  nextAiringEpisode?: number;
  coverImage?: string;
  synopsis?: string;
  /** AniList mean score, 0-100. */
  meanScore?: number;
  /** Media status: FINISHED, RELEASING, NOT_YET_RELEASED, CANCELLED, HIATUS. */
  status?: string;
  /** Episode length in minutes. */
  duration?: number;
  genres?: string[];
  studios?: string[];
}

const SEARCH_QUERY = `
query ($search: String) {
  Page(page: 1, perPage: 8) {
    media(search: $search, type: ANIME) {
      id
      idMal
      title { romaji english }
      episodes
      format
      status
      startDate { year }
      nextAiringEpisode { episode }
      coverImage { large }
      synopsis
      meanScore
      duration
      genres
      studios { nodes { name } }
    }
  }
}`;

const AIRING_QUERY = `
query ($idMal: Int) {
  Media(idMal: $idMal, type: ANIME) {
    episodes
    nextAiringEpisode { episode }
  }
}`;

const FORMAT_PRIORITY: Record<string, number> = {
  TV: 0,
  ONA: 1,
  TV_SHORT: 2,
  SPECIAL: 3,
  MOVIE: 4,
  OVA: 5,
};

export class AnimeNotFoundError extends Error {
  constructor(query: string) {
    super(`no matches for "${query}"`);
    this.name = 'AnimeNotFoundError';
  }
}

export class AniListClient {
  private cache = new Map<string, { at: number; results: AnimeMatch[] }>();

  constructor(
    private readonly ttlMs: number,
    private readonly endpoint = 'https://graphql.anilist.co',
  ) {}

  async search(rawQuery: string): Promise<AnimeMatch[]> {
    const query = rawQuery.trim().replace(/\s+/g, ' ');
    if (!query) {
      return [];
    }
    const key = query.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.ttlMs) {
      return cached.results;
    }
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: SEARCH_QUERY, variables: { search: query } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`AniList search failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      data?: {
        Page?: { media?: Array<Record<string, unknown>> };
      };
    };
    const media = json.data?.Page?.media ?? [];
    const seen = new Set<number>();
    const results: AnimeMatch[] = [];
    for (const m of media) {
      const malId = Number(m.idMal);
      if (!Number.isFinite(malId) || malId <= 0 || seen.has(malId)) {
        continue;
      }
      const title = (m.title as { romaji?: string; english?: string } | null) ?? {};
      const match: AnimeMatch = {
        malId,
        anilistId: Number(m.id),
        title: title.romaji ?? title.english ?? `MAL #${malId}`,
        englishTitle: title.english,
        episodes: m.episodes == null ? undefined : Number(m.episodes),
        format: String(m.format ?? 'TV'),
        year: (m.startDate as { year?: number | null } | null)?.year ?? undefined,
        nextAiringEpisode: (m.nextAiringEpisode as { episode?: number } | null)?.episode,
        coverImage: (m.coverImage as { large?: string } | null)?.large,
        synopsis: typeof m.synopsis === 'string' ? m.synopsis : undefined,
        meanScore: m.meanScore == null ? undefined : Number(m.meanScore),
        status: typeof m.status === 'string' ? m.status : undefined,
        duration: m.duration == null ? undefined : Number(m.duration),
        genres: Array.isArray(m.genres) ? m.genres.map(String).filter(Boolean) : undefined,
        studios: Array.isArray((m.studios as { nodes?: unknown } | null)?.nodes)
          ? (m.studios as { nodes?: Array<{ name?: string }> }).nodes!.map((s) => s.name ?? '').filter(Boolean)
          : undefined,
      };
      seen.add(malId);
      results.push(match);
    }
    results.sort((a, b) => (FORMAT_PRIORITY[a.format] ?? 9) - (FORMAT_PRIORITY[b.format] ?? 9));
    const top = results.slice(0, 5);
    this.cache.set(key, { at: Date.now(), results: top });
    if (this.cache.size > 200) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    return top;
  }

  flush(): void {
    this.cache.clear();
  }

  /** Latest-episode facts for a single MAL id (used by the subscription poller). */
  async airingInfo(malId: number): Promise<{ episodes?: number; nextAiringEpisode?: number } | null> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: AIRING_QUERY, variables: { idMal: malId } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`AniList airing lookup failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      data?: { Media?: { episodes?: unknown; nextAiringEpisode?: { episode?: unknown } | null } | null };
    };
    const media = json.data?.Media;
    if (!media) {
      return null;
    }
    return {
      episodes: media.episodes == null ? undefined : Number(media.episodes),
      nextAiringEpisode: media.nextAiringEpisode?.episode == null ? undefined : Number(media.nextAiringEpisode.episode),
    };
  }
}