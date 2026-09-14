/**
 * Scholarly discovery — DOI-first, keyless, and open by construction.
 *
 * WHY THIS EXISTS
 * Credentialed aggregators (ResearchGate, Academia.edu, publisher portals) are a RETRIEVAL
 * route the human operates, never something the tool drives: their terms prohibit automated
 * access, and the cost of a violation lands on the user's personal account, not on the
 * project. So the tool does discovery through open infrastructure and hands off.
 *
 * That turns out to be better practice anyway. An aggregator's real value is PDF access,
 * not discovery — and discovery is exactly what the open stack does well:
 *
 *   OpenAlex     works, authors, citation graph          keyless, CC0
 *   Crossref     the DOI registry itself                 keyless
 *   Europe PMC   biomedical full text and abstracts      keyless
 *   arXiv        preprints                               keyless
 *   Unpaywall    LEGAL open-access copies of paywalled works    keyless (email courtesy)
 *
 * All five verified live and keyless. Unpaywall is the important one: it finds the copy the
 * publisher or author has already made lawfully available, which resolves most paywalls
 * without anyone bending anything.
 *
 * POLITE POOL
 * Crossref and Unpaywall ask for a contact address and give better service to requests that
 * carry one. This is the opposite of the tracking problem elsewhere: here identification is
 * explicitly invited and reciprocated, on a small set of scholarly infrastructure the user
 * chooses to query. It is still opt-in — `mailto` is configurable and omittable.
 *
 * Host-agnostic: no imports, web-standard `fetch` only.
 */

export type ScholarlySource = 'openalex' | 'crossref' | 'europepmc' | 'arxiv';

export interface ScholarlyWork {
    /** DOI without a URL prefix, lowercased. The identity, when one exists. */
    doi?: string;
    title: string;
    authors: string[];
    year?: number;
    venue?: string;
    /** Landing page, publisher or repository. */
    url?: string;
    abstract?: string;
    citedByCount?: number;
    source: ScholarlySource;
    /** Whether the source itself flags an open-access copy. Confirm via Unpaywall. */
    openAccess?: boolean;
}

export interface OpenAccessCopy {
    url: string;
    /** 'publisher' | 'repository' — where the lawful copy lives. */
    hostType?: string;
    version?: string;
    license?: string;
}

export interface AccessRoute {
    doi: string;
    /** A lawful open copy, when one exists. */
    openAccess?: OpenAccessCopy;
    /** What the human must do when no open copy exists. */
    handoff?: string;
    landingPage?: string;
}

export interface ScholarlyOptions {
    /** Contact address for the polite pools. Optional; omit to stay unidentified. */
    mailto?: string;
    maxResults?: number;
    timeoutMs?: number;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    sources?: ScholarlySource[];
}

const UA_BASE = 'Harmony-Research/0.1';
const DEFAULT_TIMEOUT = 15_000;

function ua(opts: ScholarlyOptions): string {
    return opts.mailto ? `${UA_BASE} (mailto:${opts.mailto})` : UA_BASE;
}

async function getJson(url: string, opts: ScholarlyOptions): Promise<any | undefined> {
    const doFetch = opts.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
    try {
        const res = await doFetch(url, {
            headers: { 'User-Agent': ua(opts), 'Accept': 'application/json' },
            signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT),
        });
        if (!res.ok) return undefined;
        return await res.json();
    } catch {
        return undefined;
    }
}

async function getText(url: string, opts: ScholarlyOptions): Promise<string | undefined> {
    const doFetch = opts.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
    try {
        const res = await doFetch(url, {
            headers: { 'User-Agent': ua(opts) },
            signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT),
        });
        return res.ok ? await res.text() : undefined;
    } catch {
        return undefined;
    }
}

/** Strip URL prefixes and casing so the same work has one identity. */
export function normalizeDoi(raw: string): string {
    return raw.trim()
        .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
        .replace(/^doi:/i, '')
        .toLowerCase();
}

/** OpenAlex stores abstracts as an inverted index; rebuild the text. */
function abstractFromInverted(inv: Record<string, number[]> | undefined): string | undefined {
    if (!inv) return undefined;
    const words: string[] = [];
    for (const [word, positions] of Object.entries(inv)) {
        for (const p of positions) words[p] = word;
    }
    const text = words.filter(Boolean).join(' ').trim();
    return text || undefined;
}

// ─── Per-source adapters ────────────────────────────────────────────────────

async function searchOpenAlex(q: string, opts: ScholarlyOptions): Promise<ScholarlyWork[]> {
    const n = opts.maxResults ?? 10;
    const mail = opts.mailto ? `&mailto=${encodeURIComponent(opts.mailto)}` : '';
    const data = await getJson(
        `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=${n}${mail}`, opts);
    return (data?.results ?? []).map((w: any): ScholarlyWork => ({
        doi: w.doi ? normalizeDoi(w.doi) : undefined,
        title: w.display_name ?? '(untitled)',
        authors: (w.authorships ?? []).map((a: any) => a?.author?.display_name).filter(Boolean).slice(0, 12),
        year: w.publication_year,
        venue: w.primary_location?.source?.display_name,
        url: w.primary_location?.landing_page_url ?? w.doi,
        abstract: abstractFromInverted(w.abstract_inverted_index),
        citedByCount: w.cited_by_count,
        openAccess: w.open_access?.is_oa,
        source: 'openalex',
    }));
}

async function searchCrossref(q: string, opts: ScholarlyOptions): Promise<ScholarlyWork[]> {
    const n = opts.maxResults ?? 10;
    const mail = opts.mailto ? `&mailto=${encodeURIComponent(opts.mailto)}` : '';
    const data = await getJson(
        `https://api.crossref.org/works?query=${encodeURIComponent(q)}&rows=${n}${mail}`, opts);
    return (data?.message?.items ?? []).map((w: any): ScholarlyWork => ({
        doi: w.DOI ? normalizeDoi(w.DOI) : undefined,
        title: Array.isArray(w.title) ? w.title[0] : (w.title ?? '(untitled)'),
        authors: (w.author ?? []).map((a: any) =>
            [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean).slice(0, 12),
        year: w.issued?.['date-parts']?.[0]?.[0],
        venue: Array.isArray(w['container-title']) ? w['container-title'][0] : undefined,
        url: w.URL,
        citedByCount: w['is-referenced-by-count'],
        source: 'crossref',
    }));
}

async function searchEuropePmc(q: string, opts: ScholarlyOptions): Promise<ScholarlyWork[]> {
    const n = opts.maxResults ?? 10;
    const data = await getJson(
        `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}` +
        `&format=json&pageSize=${n}`, opts);
    return (data?.resultList?.result ?? []).map((w: any): ScholarlyWork => ({
        doi: w.doi ? normalizeDoi(w.doi) : undefined,
        title: w.title ?? '(untitled)',
        authors: (w.authorString ?? '').split(/,\s*/).filter(Boolean).slice(0, 12),
        year: w.pubYear ? Number(w.pubYear) : undefined,
        venue: w.journalTitle,
        url: w.doi ? `https://doi.org/${normalizeDoi(w.doi)}` : undefined,
        openAccess: w.isOpenAccess === 'Y',
        source: 'europepmc',
    }));
}

async function searchArxiv(q: string, opts: ScholarlyOptions): Promise<ScholarlyWork[]> {
    const n = opts.maxResults ?? 10;
    const xml = await getText(
        `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&max_results=${n}`, opts);
    if (!xml) return [];
    const out: ScholarlyWork[] = [];
    for (const entry of xml.split('<entry>').slice(1)) {
        const pick = (t: string) => {
            const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(entry);
            return m ? m[1].replace(/\s+/g, ' ').trim() : undefined;
        };
        const id = pick('id');
        const published = pick('published');
        out.push({
            doi: /<arxiv:doi>([\s\S]*?)<\/arxiv:doi>/.exec(entry)?.[1]?.trim(),
            title: pick('title') ?? '(untitled)',
            authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m => m[1].trim()).slice(0, 12),
            year: published ? Number(published.slice(0, 4)) : undefined,
            venue: 'arXiv',
            url: id,
            abstract: pick('summary'),
            openAccess: true, // arXiv is open by definition
            source: 'arxiv',
        });
    }
    return out;
}

const ADAPTERS: Record<ScholarlySource, (q: string, o: ScholarlyOptions) => Promise<ScholarlyWork[]>> = {
    openalex: searchOpenAlex,
    crossref: searchCrossref,
    europepmc: searchEuropePmc,
    arxiv: searchArxiv,
};

// ─── Search ─────────────────────────────────────────────────────────────────

export interface ScholarlyResult {
    query: string;
    /** Merged by DOI, with which sources agreed on each work. */
    works: (ScholarlyWork & { corroboratedBy: ScholarlySource[] })[];
    sourcesUsed: ScholarlySource[];
    sourcesFailed: { source: ScholarlySource; reason: string }[];
}

/**
 * Query the open scholarly stack in parallel and merge by DOI.
 *
 * Merging keeps `corroboratedBy` rather than silently deduplicating: several registries
 * independently holding a DOI is a signal, and collapsing it would throw away the same
 * information the corroborate mode exists to surface.
 */
export async function searchScholarly(query: string, opts: ScholarlyOptions = {}): Promise<ScholarlyResult> {
    const sources = opts.sources ?? (['openalex', 'crossref', 'europepmc', 'arxiv'] as ScholarlySource[]);
    const sourcesUsed: ScholarlySource[] = [];
    const sourcesFailed: { source: ScholarlySource; reason: string }[] = [];

    const settled = await Promise.all(sources.map(async s => {
        try {
            const works = await ADAPTERS[s](query, opts);
            if (works.length === 0) { sourcesFailed.push({ source: s, reason: 'no results' }); return []; }
            sourcesUsed.push(s);
            return works;
        } catch (e) {
            sourcesFailed.push({ source: s, reason: (e as Error).message });
            return [];
        }
    }));

    const byKey = new Map<string, ScholarlyWork & { corroboratedBy: ScholarlySource[] }>();
    for (const work of settled.flat()) {
        // DOI where present; otherwise a normalised title, so untagged preprints still merge.
        const key = work.doi ?? `title:${work.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, { ...work, corroboratedBy: [work.source] });
        } else {
            // Distinct sources only: one registry returning a work twice is not two
            // registries agreeing. Corroboration count is a signal, and inflating it with
            // same-source duplicates manufactures exactly the confidence it should measure.
            if (!existing.corroboratedBy.includes(work.source)) existing.corroboratedBy.push(work.source);
            // Fill gaps without overwriting: first source to supply a field keeps it.
            existing.abstract ??= work.abstract;
            existing.venue ??= work.venue;
            existing.year ??= work.year;
            existing.url ??= work.url;
            existing.doi ??= work.doi;
            existing.openAccess ||= work.openAccess;
            if ((work.citedByCount ?? 0) > (existing.citedByCount ?? 0)) {
                existing.citedByCount = work.citedByCount;
            }
        }
    }

    const works = [...byKey.values()].sort((a, b) =>
        b.corroboratedBy.length - a.corroboratedBy.length ||
        (b.citedByCount ?? 0) - (a.citedByCount ?? 0));

    return { query, works, sourcesUsed, sourcesFailed };
}

// ─── Lawful access resolution ───────────────────────────────────────────────

/**
 * Find a legally available open-access copy via Unpaywall, or say plainly that the human
 * must retrieve it themselves.
 *
 * The handoff is the point. When no open copy exists, the tool does not reach for a
 * credentialed aggregator or a mirror of uncertain provenance — it names the DOI and stops,
 * because retrieval through the user's own access is theirs to perform, not the AI's.
 */
export async function resolveAccess(doiRaw: string, opts: ScholarlyOptions = {}): Promise<AccessRoute> {
    const doi = normalizeDoi(doiRaw);
    const route: AccessRoute = { doi, landingPage: `https://doi.org/${doi}` };

    const email = opts.mailto ?? 'unpaywall@impactstory.org'; // Unpaywall requires an address
    const data = await getJson(
        `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`, opts);

    const best = data?.best_oa_location;
    if (best?.url) {
        route.openAccess = {
            url: best.url_for_pdf ?? best.url,
            hostType: best.host_type,
            version: best.version,
            license: best.license,
        };
        return route;
    }

    route.handoff =
        `No lawful open-access copy found for ${doi}. Retrieve it through your own access ` +
        `(institutional login, library, or a credentialed service you hold) and bring the text back — ` +
        `the tool will not operate a logged-in session on your behalf.`;
    return route;
}

/** Compact rendering for tool output. */
export function formatWorks(result: ScholarlyResult, limit = 8): string {
    const L = [`${result.works.length} work(s) for "${result.query}"`,
        `sources: ${result.sourcesUsed.join(', ') || 'none'}` +
        (result.sourcesFailed.length ? ` · no results from ${result.sourcesFailed.map(f => f.source).join(', ')}` : ''),
        ''];
    for (const w of result.works.slice(0, limit)) {
        L.push(`${w.title.slice(0, 90)}`);
        L.push(`  ${w.authors.slice(0, 3).join(', ')}${w.authors.length > 3 ? ' et al.' : ''}` +
            `${w.year ? ` (${w.year})` : ''}${w.venue ? ` · ${w.venue.slice(0, 40)}` : ''}`);
        L.push(`  doi:${w.doi ?? '—'}  cited:${w.citedByCount ?? '—'}  oa:${w.openAccess ? 'yes' : '?'}` +
            `  corroborated by ${w.corroboratedBy.length}: ${w.corroboratedBy.join('+')}`);
    }
    return L.join('\n');
}
