/**
 * Institutional index — sovereign, keyless, local-first retrieval over institutional
 * document repositories.
 *
 * Host-agnostic by design: zero `vscode` imports, zero native dependencies, zero
 * third-party packages. Uses only web-standard APIs (fetch, DecompressionStream) so
 * it runs unchanged in the VS Code extension host, the Tauri floating UI, the CLI,
 * or a bridge node.
 *
 * SOURCES ARE USER-CONFIGURED, NOT BUNDLED:
 * This module ships a generic harvester over sanctioned protocols (OAI-PMH and
 * sitemaps). No institutional repositories are hardcoded — you point it at your own
 * endpoints. OAI-PMH exists precisely to be harvested, and a sitemap is published to
 * be read; both are consent-by-design, unlike scraping a site that has not invited it.
 *
 * COVERAGE CAVEAT — READ BEFORE RELYING ON THIS:
 * A repository's OAI-PMH feed may expose only a subset of its holdings. `verb=ListSets`
 * tells you which sets are available; `completeListSize` reports the record count.
 * Never infer "not present" from "not in this feed" — absence in one endpoint is not
 * evidence of non-existence. Widening coverage is a request to the repository operator
 * to expose more sets, not a crawling problem to engineer around.
 *
 * LIVENESS lives in citationRecord.ts, not here. A harvest answers "what exists";
 * re-checking a cited URL later answers "does it still say that" — a provenance concern,
 * and the verdict vocabulary (live-unchanged | altered | moved | soft-404 | removed |
 * blocked | transient-error) is shared with the citation format spec.
 *
 * TWO-PHASE BY DESIGN (verbatim-or-abstain):
 *   Phase 1 harvest  -> metadata (title/abstract/subjects). This is a LEAD.
 *                       evidence_tier: 'snippet' — NOT citable as authority.
 *   Phase 2 ingest   -> fetch the document, extract operative text.
 *                       evidence_tier: 'content' — citable.
 * The tier is never asserted optimistically; it reflects what was actually retrieved.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type InstitutionalStrategy = 'oai-pmh' | 'sitemap';

export interface InstitutionalSource {
    /** Domain key, e.g. 'example.org'. Becomes the engine id `primary:<domain>`. */
    domain: string;
    label: string;
    strategy: InstitutionalStrategy;
    /** OAI-PMH base endpoint (strategy 'oai-pmh'). */
    endpoint?: string;
    /** Origin to probe for robots.txt / sitemaps (strategy 'sitemap'). */
    origin?: string;
    /** OAI metadata prefix. Defaults to oai_dc (Dublin Core — universally supported). */
    metadataPrefix?: string;
}

export interface IndexedDoc {
    id: string;
    url: string;
    title: string;
    /** Harvested metadata text, or extracted operative text once ingested. */
    text: string;
    /** Honest provenance of `text`. Only 'content' is citable. */
    tier: 'snippet' | 'content';
    /** YYYY-MM-DD of the ORIGINAL retrieval. Never rewritten on re-read. */
    retrieved: string;
    /** Owning domain. */
    domain: string;
    lastmod?: string;
}

/** Persistence is injected so the host chooses storage (file, sqlite, memory). */
export interface IndexStore {
    load(domain: string): Promise<IndexedDoc[]>;
    save(domain: string, docs: IndexedDoc[]): Promise<void>;
}

export interface HarvestOptions {
    /** Hard cap on records fetched. Bounded by default — this walks someone's server. */
    maxRecords?: number;
    /** Override robots.txt Crawl-delay. Never set below the site's declared value. */
    delayMsOverride?: number;
    requestTimeoutMs?: number;
    /** Incremental harvest: OAI `from` date (YYYY-MM-DD). */
    since?: string;
    signal?: AbortSignal;
    onProgress?: (fetched: number, total: number | undefined) => void;
}

export interface RobotsRules {
    crawlDelayMs: number;
    disallow: string[];
    sitemaps: string[];
}

const UA = 'Harmony-Search/0.1 (institutional-index; +https://github.com/harmony)';
const DEFAULT_MAX_RECORDS = 500;
const DEFAULT_TIMEOUT_MS = 20_000;
/** Floor politeness delay when a site declares none. */
const DEFAULT_DELAY_MS = 1_000;

// ─── Curated sources (verified reachable 2026-09-05) ────────────────────────

export const INSTITUTIONAL_SOURCES: InstitutionalSource[] = [
    // Intentionally empty: no institutional repositories are bundled. The harvester is
    // generic — wire in your own OAI-PMH or sitemap sources through your configuration.
];

// ─── Small utilities ────────────────────────────────────────────────────────

function today(): string {
    return new Date().toISOString().slice(0, 10);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    });
}

function decodeEntities(s: string): string {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
        .replace(/&amp;/g, '&');
}

/** Minimal tag extraction. Sufficient for OAI-DC and sitemaps; not a general XML parser. */
function tagValues(xml: string, tag: string): string[] {
    const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'g');
    const out: string[] = [];
    for (const m of xml.matchAll(re)) out.push(decodeEntities(m[1].trim()));
    return out;
}

function stripHtml(html: string): string {
    return decodeEntities(
        html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
    ).replace(/\s+/g, ' ').trim();
}

async function readBody(res: Response, url: string): Promise<string> {
    // fetch() already decodes Content-Encoding transparently, so that header must NOT
    // trigger manual inflation — doing so double-decompresses and consumes the stream,
    // leaving the fallback with an unusable body. Only an explicitly gzipped *file*
    // (sitemap.xml.gz) needs inflating here.
    if (!url.endsWith('.gz') || !res.body || typeof DecompressionStream === 'undefined') {
        return res.text();
    }
    const backup = res.clone(); // readable copy, since pipeThrough consumes the original
    try {
        const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
        return await new Response(stream).text();
    } catch {
        return backup.text();
    }
}

// ─── robots.txt ─────────────────────────────────────────────────────────────

/**
 * Parse robots.txt for the wildcard agent. We honour Crawl-delay and Disallow —
 * a sovereign tool that ignores robots is just a rude crawler.
 */
export function parseRobots(text: string): RobotsRules {
    const rules: RobotsRules = { crawlDelayMs: DEFAULT_DELAY_MS, disallow: [], sitemaps: [] };
    let inWildcard = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        const field = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (field === 'sitemap') { rules.sitemaps.push(value); continue; }
        if (field === 'user-agent') { inWildcard = value === '*'; continue; }
        if (!inWildcard) continue;
        if (field === 'disallow' && value) rules.disallow.push(value);
        if (field === 'crawl-delay') {
            const secs = Number(value);
            if (Number.isFinite(secs) && secs > 0) rules.crawlDelayMs = Math.ceil(secs * 1000);
        }
    }
    return rules;
}

export function isAllowed(pathname: string, rules: RobotsRules): boolean {
    return !rules.disallow.some(rule => {
        if (rule === '/') return true;
        const prefix = rule.replace(/\*.*$/, '');
        return pathname.startsWith(prefix);
    });
}

export async function fetchRobots(origin: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RobotsRules> {
    try {
        const res = await fetch(`${origin}/robots.txt`, {
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return { crawlDelayMs: DEFAULT_DELAY_MS, disallow: [], sitemaps: [] };
        return parseRobots(await res.text());
    } catch {
        return { crawlDelayMs: DEFAULT_DELAY_MS, disallow: [], sitemaps: [] };
    }
}

// ─── Strategy 1: OAI-PMH harvest ────────────────────────────────────────────

/**
 * Harvest Dublin Core records. OAI-PMH exists precisely to be harvested, so this
 * is sanctioned access rather than tolerated scraping — the distinction that made
 * the DDG floor untenable.
 */
export async function harvestOaiPmh(
    source: InstitutionalSource,
    opts: HarvestOptions = {}
): Promise<IndexedDoc[]> {
    if (!source.endpoint) throw new Error(`${source.domain}: oai-pmh strategy requires an endpoint`);
    const max = opts.maxRecords ?? DEFAULT_MAX_RECORDS;
    const timeout = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const prefix = source.metadataPrefix ?? 'oai_dc';
    const retrieved = today();

    const origin = new URL(source.endpoint).origin;
    const robots = await fetchRobots(origin, timeout);
    const delay = opts.delayMsOverride ?? robots.crawlDelayMs;

    const docs: IndexedDoc[] = [];
    let token: string | undefined;
    let total: number | undefined;
    let first = true;

    while (docs.length < max) {
        if (opts.signal?.aborted) break;
        const url = new URL(source.endpoint);
        if (token) {
            url.searchParams.set('verb', 'ListRecords');
            url.searchParams.set('resumptionToken', token);
        } else {
            url.searchParams.set('verb', 'ListRecords');
            url.searchParams.set('metadataPrefix', prefix);
            if (opts.since) url.searchParams.set('from', opts.since);
        }

        if (!first) await sleep(delay, opts.signal);
        first = false;

        const res = await fetch(url.toString(), {
            headers: { 'User-Agent': UA },
            signal: opts.signal ?? AbortSignal.timeout(timeout),
        });
        if (!res.ok) throw new Error(`${source.domain}: OAI-PMH HTTP ${res.status}`);
        const xml = await res.text();

        const errs = tagValues(xml, 'error');
        if (errs.length && docs.length === 0) throw new Error(`${source.domain}: OAI error: ${errs[0]}`);
        if (errs.length) break;

        for (const record of xml.split('<record>').slice(1)) {
            if (docs.length >= max) break;
            const id = tagValues(record, 'identifier')[0] ?? '';
            const title = tagValues(record, 'title')[0] ?? '(untitled)';
            const description = tagValues(record, 'description').join(' ');
            const subjects = tagValues(record, 'subject').join(' ');
            const date = tagValues(record, 'date')[0];
            // Prefer an http identifier as the citable URL; fall back to the OAI id.
            const url2 = tagValues(record, 'identifier').find(v => /^https?:\/\//.test(v)) ?? id;
            if (!url2) continue;
            docs.push({
                id: id || url2,
                url: url2,
                title,
                text: [title, description, subjects].filter(Boolean).join('\n'),
                tier: 'snippet', // metadata only — a lead, not operative text
                retrieved,
                domain: source.domain,
                lastmod: date,
            });
        }

        const sizeM = /completeListSize="(\d+)"/.exec(xml);
        if (sizeM) total = Number(sizeM[1]);
        opts.onProgress?.(docs.length, total);

        const tokM = /<resumptionToken[^>]*>([\s\S]*?)<\/resumptionToken>/.exec(xml);
        token = tokM && tokM[1].trim() ? tokM[1].trim() : undefined;
        if (!token) break;
    }
    return docs;
}

// ─── Strategy 2: sitemap walk ───────────────────────────────────────────────

const SITEMAP_CANDIDATES = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemaps.xml'];

/** Discover sitemap URLs: robots.txt Sitemap: directives first, then conventional paths. */
export async function discoverSitemaps(origin: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string[]> {
    const robots = await fetchRobots(origin, timeoutMs);
    if (robots.sitemaps.length) return robots.sitemaps;
    const found: string[] = [];
    for (const path of SITEMAP_CANDIDATES) {
        try {
            const res = await fetch(origin + path, {
                headers: { 'User-Agent': UA },
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok) continue;
            const body = await readBody(res, origin + path);
            if (/<(sitemapindex|urlset)/i.test(body)) found.push(origin + path);
        } catch { /* candidate absent — expected */ }
    }
    return found;
}

export async function harvestSitemap(
    source: InstitutionalSource,
    opts: HarvestOptions = {}
): Promise<IndexedDoc[]> {
    const origin = source.origin ?? `https://${source.domain}`;
    const max = opts.maxRecords ?? DEFAULT_MAX_RECORDS;
    const timeout = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retrieved = today();

    const robots = await fetchRobots(origin, timeout);
    const delay = opts.delayMsOverride ?? robots.crawlDelayMs;

    const roots = await discoverSitemaps(origin, timeout);
    if (roots.length === 0) {
        throw new Error(
            `${source.domain}: no sitemap found (robots.txt declares none; ` +
            `${SITEMAP_CANDIDATES.join(', ')} absent or refused)`
        );
    }

    const docs: IndexedDoc[] = [];
    const seen = new Set<string>();
    const queue = [...roots];
    let depth = 0;

    while (queue.length && docs.length < max && depth < 50) {
        if (opts.signal?.aborted) break;
        const target = queue.shift()!;
        if (seen.has(target)) continue;
        seen.add(target);
        depth++;
        if (depth > 1) await sleep(delay, opts.signal);

        let body: string;
        try {
            const res = await fetch(target, {
                headers: { 'User-Agent': UA },
                signal: opts.signal ?? AbortSignal.timeout(timeout),
            });
            if (!res.ok) continue;
            body = await readBody(res, target);
        } catch { continue; }

        if (/<sitemapindex/i.test(body)) {
            for (const loc of tagValues(body, 'loc')) if (!seen.has(loc)) queue.push(loc);
            continue;
        }

        // urlset: <url><loc/><lastmod/></url>
        for (const block of body.split(/<url>/i).slice(1)) {
            if (docs.length >= max) break;
            const loc = tagValues(block, 'loc')[0];
            if (!loc) continue;
            let pathname: string;
            try { pathname = new URL(loc).pathname; } catch { continue; }
            if (!isAllowed(pathname, robots)) continue;
            docs.push({
                id: loc,
                url: loc,
                title: decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? loc).replace(/[-_]+/g, ' '),
                text: '', // sitemaps carry no text — ingest() supplies it
                tier: 'snippet',
                retrieved,
                domain: source.domain,
                lastmod: tagValues(block, 'lastmod')[0],
            });
        }
    }
    return docs;
}

export async function harvest(source: InstitutionalSource, opts: HarvestOptions = {}): Promise<IndexedDoc[]> {
    return source.strategy === 'oai-pmh' ? harvestOaiPmh(source, opts) : harvestSitemap(source, opts);
}

// ─── Phase 2: ingest operative text (promotes snippet -> content) ───────────

/**
 * Fetch a harvested document and extract its operative text. ONLY this promotes a
 * doc to evidence_tier 'content', i.e. citable under verbatim-or-abstain. The
 * original `retrieved` date is preserved — the harvest date is when we first saw it.
 */
export async function ingestDocument(
    doc: IndexedDoc,
    opts: { timeoutMs?: number; maxChars?: number; signal?: AbortSignal } = {}
): Promise<IndexedDoc> {
    const res = await fetch(doc.url, {
        headers: { 'User-Agent': UA },
        signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ingest ${doc.url}: HTTP ${res.status}`);
    const ctype = res.headers.get('content-type') ?? '';
    const raw = await readBody(res, doc.url);
    const text = ctype.includes('html') ? stripHtml(raw) : raw;
    if (!text.trim()) throw new Error(`ingest ${doc.url}: no extractable text`);
    return {
        ...doc,
        text: text.slice(0, opts.maxChars ?? 200_000),
        tier: 'content',
        // retrieved deliberately NOT updated: first-sight date is the provenance date.
    };
}

// ─── Local index + BM25 search (pure JS, no native deps) ────────────────────

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'is', 'are', 'be', 'by', 'with', 'as', 'at', 'from']);

export function tokenize(s: string): string[] {
    return s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1 && !STOP.has(t));
}

export interface ScoredDoc { doc: IndexedDoc; score: number }

/** BM25 over the in-memory corpus. Deterministic and dependency-free. */
export function searchDocs(query: string, docs: IndexedDoc[], maxResults = 10): ScoredDoc[] {
    const terms = tokenize(query);
    if (!terms.length || !docs.length) return [];

    const k1 = 1.5, b = 0.75;
    const tokenized = docs.map(d => tokenize(`${d.title} ${d.text}`));
    const lengths = tokenized.map(t => t.length);
    const avgLen = lengths.reduce((a, c) => a + c, 0) / (lengths.length || 1) || 1;

    const df = new Map<string, number>();
    for (const toks of tokenized) {
        for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
    }

    const scored: ScoredDoc[] = docs.map((doc, i) => {
        const toks = tokenized[i];
        const tf = new Map<string, number>();
        for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
        let score = 0;
        for (const term of terms) {
            const f = tf.get(term);
            if (!f) continue;
            const n = df.get(term) ?? 0;
            const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
            score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (lengths[i] / avgLen))));
        }
        return { doc, score };
    });

    return scored.filter(s => s.score > 0).sort((a, b2) => b2.score - a.score).slice(0, maxResults);
}

// ─── Adapter shape for webSearchCore federation ─────────────────────────────

/**
 * Structurally matches webSearchCore's `EngineAdapter`. It is exported as a factory
 * because there is one engine per institution: `primary:example.org`.
 *
 * INTEGRATION — one additive line in webSearchCore.ts, nothing rewritten:
 *
 *   export type EngineId =
 *       | 'google-cse' | 'gemini' | 'ddg' | 'brave' | 'yandex' | 'baidu' | 'mojeek'
 *       | `primary:${string}`;                      // <-- add
 *
 * then register:
 *
 *   for (const s of INSTITUTIONAL_SOURCES) {
 *       adapters[`primary:${s.domain}`] = createInstitutionalAdapter(s, store);
 *   }
 *
 * These belong in the union/coverage reducer, NOT the tripartite: institutional
 * corpora index disjoint universes, so "consensus" across them is a category error.
 */
export interface InstitutionalCitation {
    verbatim: string;
    source: string;
    retrieved: string;
    engine: string;
    jurisdiction: 'institutional';
    rank: number;
    evidence_tier: 'snippet' | 'content';
    title?: string;
}

export interface InstitutionalAdapter {
    id: string;
    label: string;
    jurisdiction: 'institutional';
    available(): Promise<boolean>;
    search(query: string, opts: { maxResults: number }): Promise<InstitutionalCitation[]>;
}

export function createInstitutionalAdapter(
    source: InstitutionalSource,
    store: IndexStore,
    deps: { autoIngestTop?: number } = {}
): InstitutionalAdapter {
    return {
        id: `primary:${source.domain}`,
        label: source.label,
        jurisdiction: 'institutional',

        /** Available only once a local index exists — never triggers a harvest mid-query. */
        async available(): Promise<boolean> {
            try { return (await store.load(source.domain)).length > 0; } catch { return false; }
        },

        async search(query, opts): Promise<InstitutionalCitation[]> {
            const docs = await store.load(source.domain);
            const hits = searchDocs(query, docs, opts.maxResults);

            // Promote the top hits to citable 'content' by fetching operative text.
            const promote = Math.min(deps.autoIngestTop ?? 0, hits.length);
            for (let i = 0; i < promote; i++) {
                if (hits[i].doc.tier === 'content') continue;
                try {
                    const full = await ingestDocument(hits[i].doc);
                    hits[i] = { ...hits[i], doc: full };
                    const idx = docs.findIndex(d => d.id === full.id);
                    if (idx >= 0) docs[idx] = full;
                } catch { /* leave as snippet — honest tier beats an optimistic one */ }
            }
            if (promote > 0) { try { await store.save(source.domain, docs); } catch { /* best effort */ } }

            return hits.map((h, i) => ({
                verbatim: h.doc.text.slice(0, 1200) || h.doc.title,
                source: h.doc.url,
                retrieved: h.doc.retrieved,
                engine: `primary:${source.domain}`,
                jurisdiction: 'institutional' as const,
                rank: i + 1,
                evidence_tier: h.doc.tier,
                title: h.doc.title,
            }));
        },
    };
}

// ─── Reference in-memory store (hosts supply a persistent one) ──────────────

export class MemoryIndexStore implements IndexStore {
    private readonly byDomain = new Map<string, IndexedDoc[]>();
    async load(domain: string): Promise<IndexedDoc[]> { return this.byDomain.get(domain) ?? []; }
    async save(domain: string, docs: IndexedDoc[]): Promise<void> { this.byDomain.set(domain, docs); }
}
