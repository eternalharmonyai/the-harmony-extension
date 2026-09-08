/**
 * Federation — free, keyless, open-endpoint fan-out with a union/coverage reducer.
 *
 * These are NOT search engines in the corroborate sense: they index disjoint
 * universes (scholarly metadata, encyclopedic text, archived snapshots), so
 * "agreement" across them is a category error. The reducer reports COVERAGE
 * (which endpoints answered, how many) with per-source attribution — no
 * consensus/divergence verdict is fabricated.
 *
 * Host-agnostic: zero `vscode` imports, web-standard fetch only.
 */

export type FederationEndpoint = 'arxiv' | 'crossref' | 'wikipedia' | 'wayback';

export interface OpenCitation {
    verbatim: string;
    source: string;
    retrieved: string;
    engine: string;
    jurisdiction: 'unknown' | 'independent' | 'institutional';
    rank: number;
    evidence_tier: 'snippet' | 'content';
    title?: string;
}

export interface FederationOutcome {
    citations: OpenCitation[];
    coverage: Record<string, number>;
    errors: { endpoint: string; error: string }[];
}

const UA = 'Harmony-Federation/0.1 (research; +https://github.com/harmony)';

function nowDate(): string { return new Date().toISOString().slice(0, 10); }

function htmlToText(s: string): string {
    return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tagText(xml: string, tag: string): string {
    const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return htmlToText(m?.[1] ?? '');
}

/** arXiv — free Atom API, no key. Titles/abstracts, arxiv IDs as citable sources. */
export async function searchArxiv(query: string, maxResults = 5): Promise<OpenCitation[]> {
    const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${maxResults}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`arXiv HTTP ${res.status}`);
    const xml = await res.text();
    const out: OpenCitation[] = [];
    for (const entry of xml.split('<entry>').slice(1)) {
        const id = tagText(entry, 'id');
        const title = tagText(entry, 'title');
        const summary = tagText(entry, 'summary');
        if (!id) continue;
        out.push({
            verbatim: summary || title,
            source: id,
            retrieved: nowDate(),
            engine: 'arxiv',
            jurisdiction: 'unknown',
            rank: out.length + 1,
            evidence_tier: 'snippet',
            title,
        });
    }
    return out;
}

/** Crossref — free REST API, no key (polite pool). DOIs + titles. */
export async function searchCrossref(query: string, maxResults = 5): Promise<OpenCitation[]> {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${maxResults}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Crossref HTTP ${res.status}`);
    const data = (await res.json()) as any;
    const items: any[] = data?.message?.items ?? [];
    return items.map((it, i): OpenCitation => {
        const title = Array.isArray(it?.title) ? String(it.title[0]) : String(it?.title ?? '');
        const source = it?.URL ?? (it?.DOI ? `https://doi.org/${it.DOI}` : '');
        return {
            verbatim: title,
            source,
            retrieved: nowDate(),
            engine: 'crossref',
            jurisdiction: 'unknown',
            rank: i + 1,
            evidence_tier: 'snippet',
            title,
        };
    }).filter(c => c.source);
}

/** Wikipedia — free search API, no key. Article snippets/titles. */
export async function searchWikipedia(query: string, maxResults = 5): Promise<OpenCitation[]> {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${maxResults}&format=json&origin=*`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
    const data = (await res.json()) as any;
    const results: any[] = data?.query?.search ?? [];
    return results.map((r, i) => ({
        verbatim: htmlToText(String(r?.snippet ?? '')),
        source: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(r?.title ?? '').replace(/ /g, '_'))}`,
        retrieved: nowDate(),
        engine: 'wikipedia',
        jurisdiction: 'unknown',
        rank: i + 1,
        evidence_tier: 'snippet',
        title: String(r?.title ?? ''),
    }));
}

/** Wayback CDX — free, keyless. Archived snapshots (the delisting answer). */
export async function searchWayback(query: string, maxResults = 5): Promise<OpenCitation[]> {
    const url = `http://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(query)}&output=json&limit=${maxResults}&filter=statuscode:200&collapse=urlkey`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Wayback CDX HTTP ${res.status}`);
    const json = (await res.json()) as any[][];
    const rows = json.slice(1); // first row is column headers
    return rows.map((r, i): OpenCitation => {
        const original = String(r?.[2] ?? '');
        const timestamp = String(r?.[1] ?? '');
        return {
            verbatim: `Archived snapshot ${timestamp} of ${original}`,
            source: original ? `https://web.archive.org/web/${timestamp}/${original}` : '',
            retrieved: nowDate(),
            engine: 'wayback',
            jurisdiction: 'independent',
            rank: i + 1,
            evidence_tier: 'content',
            title: original,
        };
    }).filter(c => c.source);
}

const RUNNERS: Record<FederationEndpoint, (q: string, n: number) => Promise<OpenCitation[]>> = {
    arxiv: searchArxiv,
    crossref: searchCrossref,
    wikipedia: searchWikipedia,
    wayback: searchWayback,
};

/** Fan out to all endpoints, union results, report coverage (NOT agreement). */
export async function federate(query: string, opts: { maxResults?: number; endpoints?: FederationEndpoint[] } = {}): Promise<FederationOutcome> {
    const endpoints = opts.endpoints ?? (['arxiv', 'crossref', 'wikipedia', 'wayback'] as FederationEndpoint[]);
    const maxResults = opts.maxResults ?? 5;
    const citations: OpenCitation[] = [];
    const coverage: Record<string, number> = {};
    const errors: { endpoint: string; error: string }[] = [];
    await Promise.all(endpoints.map(async (ep) => {
        try {
            const results = await RUNNERS[ep](query, maxResults);
            coverage[ep] = results.length;
            citations.push(...results);
        } catch (e: any) {
            coverage[ep] = 0;
            errors.push({ endpoint: ep, error: e?.message ?? String(e) });
        }
    }));
    return { citations, coverage, errors };
}
