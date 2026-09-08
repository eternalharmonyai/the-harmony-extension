/**
 * Web Search Core — host-agnostic search layer (no `vscode` import).
 *
 * This is the pilot for the portable-by-design host abstraction: everything
 * here depends only on an injected `SearchHost` interface (config + secrets +
 * workspace root), so it can lift into a floating UI, a CLI, or an MCP server
 * without a rewrite.
 *
 * Design (see .harmony/search/SEARCH-DESIGN.md):
 *   - Two modes: resolve (one engine, cascade) and corroborate (fan-out across
 *     independent axes, preserving per-engine attribution — no dedupe/merge).
 *   - Citation candidates are emitted shaped for verbatim-or-abstain, wire-
 *     compatible with the citation schema (verbatim-or-abstain).
 *   - Failure classification: auth/quota -> mark cold for a TTL; transient ->
 *     one jittered retry then demote; empty -> fan out, never demote.
 *   - Cache preserves the ORIGINAL `retrieved` timestamp across cache hits.
 */
import * as crypto from 'crypto';
import { INSTITUTIONAL_SOURCES, createInstitutionalAdapter, harvest, MemoryIndexStore, type IndexStore } from './institutionalIndex';
import { federate } from './federation';

// ─── Host interface (the HarmonyHost pilot) ─────────────────────────────────

export interface SearchHost {
    getConfig<T>(key: string, dflt?: T): T | undefined;
    getSecret(key: string): Promise<string | undefined>;
    workspaceRoot?: string;
}

// ─── Public types ───────────────────────────────────────────────────────────

export type EngineId =
    | 'google-cse'
    | 'gemini'
    | 'ddg'
    | 'brave'
    | 'yandex'
    | 'baidu'
    | 'mojeek';

export type Jurisdiction = 'US' | 'CN' | 'RU' | 'EU' | 'independent' | 'institutional' | 'unknown';
export type EvidenceTier = 'snippet' | 'content';
export type SearchMode = 'resolve' | 'corroborate' | 'federate';

/** A single search result, shaped as a citation candidate. */
export interface SearchCitation {
    /** Operative text. Non-empty is the verbatim-or-abstain gate. */
    verbatim: string;
    /** URL of the cited authority. */
    source: string;
    /** Date (YYYY-MM-DD) of the ORIGINAL retrieval — never overwritten on cache hit. */
    retrieved: string;
    /** Provenance: which index answered. */
    engine: string;
    jurisdiction: Jurisdiction;
    /** Position in the engine's result set. */
    rank: number;
    /** snippet = lead (not citable); content = operative text (citable). */
    evidence_tier: EvidenceTier;
    title?: string;
}

export interface SearchOutcome {
    mode: SearchMode;
    query: string;
    generated: string;
    citations: SearchCitation[];
    enginesUsed: string[];
    enginesSkipped: { engine: string; reason: string }[];
    consensus?: Record<string, string[]>;
    divergent?: Record<string, string[]>;
    absent?: string[];
    jurisdictions?: Record<string, { engines: string[]; urls: string[] }>;
    jurisdictionConsensus?: Record<string, string[]>;
    jurisdictionDivergent?: Record<string, string[]>;
    primaryDomainsTried?: string[];
    note?: string;
}

export interface SearchInput {
    query: string;
    mode?: SearchMode;
    depth?: 'basic' | 'advanced';
    freshness?: 'any' | 'day' | 'week' | 'month';
    max_results?: number;
    site?: string; // single institutional domain, or 'primary' to fan out over the list
    engines?: string[];
}

interface EngineFailure {
    kind: 'auth' | 'quota' | 'transient' | 'other' | 'unavailable';
    error: string;
    status?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DDG_HTML = 'https://html.duckduckgo.com/html/';
const CSE_API = 'https://www.googleapis.com/customsearch/v1';
const UA = 'Harmony-Search/0.1';

const HALF_LIFE_MS = 5 * 60 * 1000;
const COLD_TTL_MS = 10 * 60 * 1000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Curated primary-source domains — stable, directly queryable open endpoints (non-governmental). */
const INSTITUTIONAL_DOMAINS: Record<string, string> = {
    'archive.org': 'Internet Archive / Wayback Machine',
    'arxiv.org': 'arXiv',
};

// ─── State (health / metering / cache) ──────────────────────────────────────

interface EngineHealth {
    score: number;
    attempts: number;
    successes: number;
    coldUntil: number;
}

const health = new Map<string, EngineHealth>();
const meter = new Map<string, number>(); // engine -> fresh API calls this session (in-memory, resets on reload)
const cache = new Map<string, { citations: SearchCitation[]; savedAt: string }>();

// ─── Helpers ────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function classify(status: number | undefined, message?: string): EngineFailure['kind'] {
    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'quota';
    if (status === undefined || status === 0 || status >= 500) return 'transient';
    return 'other';
}

function failure(kind: EngineFailure['kind'], error: string, status?: number): EngineFailure {
    return { kind, error, status };
}

function nowIso(): string {
    return new Date().toISOString();
}

function nowDate(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (verdict retrieved format)
}

function cacheKeyFor(query: string, engine: string, site?: string, maxResults = 10): string {
    const norm = `${engine}\u0000${query.trim().toLowerCase()}\u0000${site ?? ''}\u0000${maxResults}`;
    return crypto.createHash('sha256').update(norm).digest('hex');
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (e: any) {
        const kind = e?.kind ?? classify(e?.status, e?.error);
        if (kind !== 'transient') throw e;
        const delay = 300 + Math.random() * 700; // jittered
        await new Promise(r => setTimeout(r, delay));
        return await fn();
    }
}

// ─── Health ─────────────────────────────────────────────────────────────────

function recordEngineHealth(engine: string, success: boolean): void {
    const h = health.get(engine) ?? { score: 0, attempts: 0, successes: 0, coldUntil: 0 };
    h.attempts += 1;
    if (success) h.successes += 1;
    h.score = Math.max(-10, Math.min(10, h.score + (success ? 1 : -2)));
    health.set(engine, h);
}

function isEngineCold(engine: string): boolean {
    return Date.now() < (health.get(engine)?.coldUntil ?? 0);
}

function markEngineCold(engine: string): void {
    const h = health.get(engine) ?? { score: -2, attempts: 1, successes: 0, coldUntil: 0 };
    h.coldUntil = Date.now() + COLD_TTL_MS;
    health.set(engine, h);
}

// ─── Metering (query budget, free-tier burn-down) ───────────────────────────

function meterRecord(engine: string): void {
    meter.set(engine, (meter.get(engine) ?? 0) + 1);
}

function meterCount(engine: string): number {
    return meter.get(engine) ?? 0;
}

// ─── Cache ──────────────────────────────────────────────────────────────────

function cacheGet(key: string, ttlMs: number): SearchCitation[] | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - Date.parse(entry.savedAt) > ttlMs) {
        cache.delete(key);
        return undefined;
    }
    // Returned citations keep their ORIGINAL `retrieved` (never overwritten).
    return entry.citations;
}

function cacheSet(key: string, citations: SearchCitation[]): void {
    cache.set(key, { citations, savedAt: nowIso() });
}

function freshnessTtl(freshness: SearchInput['freshness']): number {
    switch (freshness) {
        case 'day': return 6 * 60 * 60 * 1000;
        case 'week': return 24 * 60 * 60 * 1000;
        case 'month': return 7 * 24 * 60 * 60 * 1000;
        default: return CACHE_TTL_MS;
    }
}

// ─── Engine adapters ────────────────────────────────────────────────────────

interface EngineAdapter {
    id: EngineId;
    label: string;
    jurisdiction: Jurisdiction;
    available(host: SearchHost): Promise<boolean>;
    search(query: string, opts: { maxResults: number; site?: string; depth?: string }, host: SearchHost): Promise<SearchCitation[]>;
}

async function ddgSearch(query: string, opts: { maxResults: number; site?: string }): Promise<SearchCitation[]> {
    const q = opts.site ? `site:${opts.site} ${query}` : query;
    const res = await fetch(`${DDG_HTML}?q=${encodeURIComponent(q)}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw failure(classify(res.status), `DDG HTTP ${res.status}`, res.status);
    const html = await res.text();
    const citations = parseDdg(html, opts.maxResults, opts.site);
    if (citations.length === 0) throw failure('other', 'DDG returned no parseable results', res.status);
    return citations;
}

function parseDdg(html: string, maxResults: number, site?: string): SearchCitation[] {
    const out: SearchCitation[] = [];
    const blocks = html.split(/class="result results_links/).slice(1);
    for (const block of blocks) {
        if (out.length >= maxResults) break;
        const linkM = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
        if (!linkM) continue;
        let url = linkM[1];
        const uddg = /uddg=([^&]+)/.exec(url);
        if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch { /* keep as-is */ } }
        if (!/^https?:\/\//i.test(url)) continue;
        const title = stripHtml(linkM[2]);
        const snipM = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
        const snippet = snipM ? stripHtml(snipM[1]) : '';
        out.push({
            verbatim: [title, snippet].filter(Boolean).join(' — '),
            source: url,
            retrieved: nowDate(),
            engine: 'ddg',
            jurisdiction: site ? 'institutional' : 'US',
            rank: out.length + 1,
            evidence_tier: 'snippet',
            title,
        });
    }
    return out;
}

async function cseSearch(query: string, opts: { maxResults: number; site?: string }, host: SearchHost): Promise<SearchCitation[]> {
    const key = await host.getSecret('harmony.googleCse.apiKey');
    const cx = await host.getSecret('harmony.googleCse.cx');
    if (!key || !cx) throw failure('auth', 'missing harmony.googleCse.apiKey or harmony.googleCse.cx');
    const num = Math.min(10, Math.max(1, opts.maxResults));
    const params = new URLSearchParams({ key, cx, q: query, num: String(num) });
    if (opts.site) params.set('siteSearch', opts.site);
    const res = await fetch(`${CSE_API}?${params.toString()}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw failure(classify(res.status), `Google CSE HTTP ${res.status}`, res.status);
    const data = (await res.json()) as any;
    const items: any[] = data?.items ?? [];
    return items.map((it, i) => ({
        verbatim: it.snippet ?? '',
        source: it.link,
        retrieved: nowDate(),
        engine: 'google-cse',
        jurisdiction: opts.site ? 'institutional' : 'US',
        rank: i + 1,
        evidence_tier: 'snippet' as EvidenceTier,
        title: it.title,
    }));
}

const adapters: Record<EngineId, EngineAdapter> = {
    'google-cse': {
        id: 'google-cse', label: 'Google CSE', jurisdiction: 'US',
        available: async (host) => Boolean(await host.getSecret('harmony.googleCse.apiKey') && await host.getSecret('harmony.googleCse.cx')),
        search: (q, o, h) => cseSearch(q, o, h),
    },
    'gemini': {
        id: 'gemini', label: 'Gemini grounding', jurisdiction: 'US',
        available: async () => false, // not wired in v1 (needs grounding tool config)
        search: async () => { throw failure('unavailable', 'Gemini grounding not wired in v1'); },
    },
    'ddg': {
        id: 'ddg', label: 'DuckDuckGo (no-key floor)', jurisdiction: 'US',
        available: async () => true,
        search: (q, o) => ddgSearch(q, o),
    },
    'brave': {
        id: 'brave', label: 'Brave (own crawler)', jurisdiction: 'US',
        available: async (host) => Boolean(await host.getSecret('harmony.brave.apiKey')),
        search: async () => { throw failure('unavailable', 'Brave adapter not implemented in v1'); },
    },
    'yandex': {
        id: 'yandex', label: 'Yandex (own crawler)', jurisdiction: 'RU',
        available: async () => false,
        search: async () => { throw failure('unavailable', 'Yandex adapter not implemented in v1'); },
    },
    'baidu': {
        id: 'baidu', label: 'Baidu (own crawler)', jurisdiction: 'CN',
        available: async () => false,
        search: async () => { throw failure('unavailable', 'Baidu adapter not implemented in v1'); },
    },
    'mojeek': {
        id: 'mojeek', label: 'Mojeek (independent index)', jurisdiction: 'independent',
        available: async () => false,
        search: async () => { throw failure('unavailable', 'Mojeek adapter not implemented in v1'); },
    },
};

// ─── Resolve (default) ──────────────────────────────────────────────────────

async function resolve(query: string, opts: SearchInput, host: SearchHost): Promise<SearchOutcome> {
    const order: EngineId[] = opts.engines?.length ? (opts.engines as EngineId[]) : ['google-cse', 'gemini', 'ddg'];
    const citations: SearchCitation[] = [];
    const used: string[] = [];
    const skipped: { engine: string; reason: string }[] = [];
    const maxResults = opts.max_results ?? 10;

    for (const id of order) {
        const adapter = adapters[id];
        if (!adapter) { skipped.push({ engine: id, reason: 'unknown engine' }); continue; }
        if (isEngineCold(id)) { skipped.push({ engine: id, reason: 'cold (recent auth/quota failure)' }); continue; }
        let available = false;
        try { available = await adapter.available(host); } catch { available = false; }
        if (!available) { skipped.push({ engine: id, reason: 'no key / unavailable' }); continue; }

        const key = cacheKeyFor(query, id, opts.site, maxResults);
        const cached = cacheGet(key, freshnessTtl(opts.freshness));
        if (cached) {
            citations.push(...cached);
            used.push(id);
            break;
        }

        try {
            const results = await withRetry(() => adapter.search(query, { maxResults, site: opts.site, depth: opts.depth }, host));
            recordEngineHealth(id, true);
            meterRecord(id);
            used.push(id);
            if (results.length > 0) {
                cacheSet(key, results);
                citations.push(...results);
                break;
            }
            skipped.push({ engine: id, reason: 'empty results (fanning out)' });
        } catch (e: any) {
            const kind = e?.kind ?? classify(e?.status, e?.error);
            recordEngineHealth(id, false);
            if (kind === 'auth' || kind === 'quota') markEngineCold(id);
            skipped.push({ engine: id, reason: `${kind}: ${e?.error ?? e?.message ?? 'error'}` });
        }
    }

    return { mode: 'resolve', query, generated: nowIso(), citations, enginesUsed: used, enginesSkipped: skipped };
}

/**
 * Comparison identity for corroborate grouping ONLY. The same document spelled
 * differently across indexes must compare equal — WITHOUT merging the results
 * themselves. The original URL stays in the citation; this key is never shown.
 * Normalizing the comparison key is not deduping: we still refuse to merge.
 */
function comparisonKey(url: string): string {
    const u = url.trim();
    try {
        const p = new URL(u);
        let host = p.hostname.toLowerCase();
        for (const prefix of ['www.', 'm.', 'amp.']) {
            if (host.startsWith(prefix)) host = host.slice(prefix.length);
        }
        let path = p.pathname.replace(/\/+$/, '');
        path = path.replace(/\/amp\/?$/, '/').replace(/\/amp\//, '/');
        const TRACK = /^(utm_|gclid|fbclid|mc_|ref$|spm|__|wbraid|gbraid|dclid)/i;
        for (const k of [...p.searchParams.keys()]) {
            if (TRACK.test(k)) p.searchParams.delete(k);
        }
        return `https://${host}${path}${p.search}`;
    } catch {
        let s = u.replace(/^https?:\/\//i, '').toLowerCase();
        for (const prefix of ['www.', 'm.', 'amp.']) {
            if (s.startsWith(prefix)) s = s.slice(prefix.length);
        }
        return s.replace(/\/+$/, '');
    }
}

// ─── Corroborate (fan-out, preserve attribution) ────────────────────────────

async function corroborate(query: string, opts: SearchInput, host: SearchHost): Promise<SearchOutcome> {
    const order: EngineId[] = opts.engines?.length ? (opts.engines as EngineId[]) : ['google-cse', 'gemini', 'ddg', 'brave', 'yandex', 'baidu', 'mojeek'];
    const candidates: EngineId[] = [];
    const skipped: { engine: string; reason: string }[] = [];
    const maxResults = opts.max_results ?? 10;

    for (const id of order) {
        const adapter = adapters[id];
        if (!adapter) { skipped.push({ engine: id, reason: 'unknown engine' }); continue; }
        if (isEngineCold(id)) { skipped.push({ engine: id, reason: 'cold (recent auth/quota failure)' }); continue; }
        let available = false;
        try { available = await adapter.available(host); } catch { available = false; }
        if (!available) { skipped.push({ engine: id, reason: 'no key / unavailable' }); continue; }
        candidates.push(id);
    }

    const perEngine = await Promise.all(candidates.map(async id => {
        const adapter = adapters[id];
        const key = cacheKeyFor(query, id, opts.site, maxResults);
        const cached = cacheGet(key, freshnessTtl(opts.freshness));
        if (cached) { recordEngineHealth(id, true); return { engine: id, citations: cached, ok: true }; }
        try {
            const results = await withRetry(() => adapter.search(query, { maxResults, site: opts.site, depth: opts.depth }, host));
            recordEngineHealth(id, true);
            meterRecord(id);
            if (results.length > 0) cacheSet(key, results);
            return { engine: id, citations: results, ok: true };
        } catch (e: any) {
            const kind = e?.kind ?? classify(e?.status, e?.error);
            recordEngineHealth(id, false);
            if (kind === 'auth' || kind === 'quota') markEngineCold(id);
            skipped.push({ engine: id, reason: `${kind}: ${e?.error ?? e?.message ?? 'error'}` });
            return { engine: id, citations: [], ok: false };
        }
    }));

    const okEngines = perEngine.filter(r => r.ok);
    const allCitations = okEngines.flatMap(r => r.citations);
    if (okEngines.length < 2) {
        return {
            mode: 'corroborate', query, generated: nowIso(), citations: allCitations,
            enginesUsed: okEngines.map(r => r.engine), enginesSkipped: skipped,
            consensus: {}, divergent: {}, absent: [],
            note: `Insufficient indexes for cross-index corroboration (${okEngines.length} live of ${order.length} requested). Consensus/divergence requires ≥2 indexes — no cross-index verdict is asserted.`,
        };
    }
    const keyToEngines = new Map<string, Set<string>>();
    const keyToUrl = new Map<string, string>();
    for (const c of allCitations) {
        const key = comparisonKey(c.source);
        if (!keyToEngines.has(key)) {
            keyToEngines.set(key, new Set());
            keyToUrl.set(key, c.source); // canonical: first-seen original URL
        }
        keyToEngines.get(key)!.add(c.engine);
    }

    const consensus: Record<string, string[]> = {};
    for (const [key, engines] of keyToEngines.entries()) {
        if (engines.size >= 2) consensus[keyToUrl.get(key)!] = [...engines].sort();
    }
    const divergent: Record<string, string[]> = {};
    for (const r of okEngines) {
        const unique = r.citations.filter(c => (keyToEngines.get(comparisonKey(c.source))?.size ?? 0) === 1).map(c => c.source);
        if (unique.length) divergent[r.engine] = unique;
    }
    const absent = okEngines.filter(r => r.citations.length === 0).map(r => r.engine);

    // ── Jurisdiction grouping: cross-jurisdiction divergence IS signal ─────
    // Use each engine's STABLE jurisdiction (US/RU/CN/independent), not the
    // site-overridden 'institutional' value, so the grouping is a true
    // "which national/independent index found this" comparison.
    const keyToJurisdictions = new Map<string, Set<string>>();
    const jurisdictionToUrls = new Map<string, Set<string>>();
    const jurisdictionToEngines = new Map<string, Set<string>>();
    for (const c of allCitations) {
        const key = comparisonKey(c.source);
        const adapter = adapters[c.engine as EngineId];
        const jur: Jurisdiction = adapter?.jurisdiction ?? c.jurisdiction;
        if (!keyToJurisdictions.has(key)) keyToJurisdictions.set(key, new Set());
        keyToJurisdictions.get(key)!.add(jur);
        if (!jurisdictionToUrls.has(jur)) jurisdictionToUrls.set(jur, new Set());
        jurisdictionToUrls.get(jur)!.add(keyToUrl.get(key) ?? c.source);
        if (!jurisdictionToEngines.has(jur)) jurisdictionToEngines.set(jur, new Set());
        jurisdictionToEngines.get(jur)!.add(c.engine);
    }
    const jurisdictionConsensus: Record<string, string[]> = {};
    for (const [key, jurs] of keyToJurisdictions.entries()) {
        if (jurs.size >= 2) jurisdictionConsensus[keyToUrl.get(key)!] = [...jurs].sort();
    }
    const jurisdictionDivergent: Record<string, string[]> = {};
    for (const [key, jurs] of keyToJurisdictions.entries()) {
        if (jurs.size === 1) {
            const jur = [...jurs][0];
            if (!jurisdictionDivergent[jur]) jurisdictionDivergent[jur] = [];
            jurisdictionDivergent[jur].push(keyToUrl.get(key)!);
        }
    }
    const jurisdictions: Record<string, { engines: string[]; urls: string[] }> = {};
    for (const [jur, engines] of jurisdictionToEngines.entries()) {
        jurisdictions[jur] = {
            engines: [...engines].sort(),
            urls: [...(jurisdictionToUrls.get(jur) ?? [])],
        };
    }

    return {
        mode: 'corroborate', query, generated: nowIso(), citations: allCitations,
        enginesUsed: okEngines.map(r => r.engine), enginesSkipped: skipped,
        consensus, divergent, absent,
        jurisdictions, jurisdictionConsensus, jurisdictionDivergent,
    };
}

// ─── Primary-source tier ────────────────────────────────────────────────────

// ─── Primary-source tier (keyless, sovereign institutional index) ───────────

const institutionalStore: IndexStore = new MemoryIndexStore();
const institutionalAdapters = new Map<string, ReturnType<typeof createInstitutionalAdapter>>();
for (const source of INSTITUTIONAL_SOURCES) {
    institutionalAdapters.set(source.domain, createInstitutionalAdapter(source, institutionalStore, { autoIngestTop: 3 }));
}

/** Bounded, polite harvest of all institutional sources (OAI-PMH / sitemaps). Populates the local index. */
export async function harvestInstitutionalIndex(maxRecords = 500): Promise<{ domain: string; docs: number; error?: string }[]> {
    const out: { domain: string; docs: number; error?: string }[] = [];
    for (const source of INSTITUTIONAL_SOURCES) {
        try {
            const docs = await harvest(source, { maxRecords });
            await institutionalStore.save(source.domain, docs);
            out.push({ domain: source.domain, docs: docs.length });
        } catch (e: any) {
            out.push({ domain: source.domain, docs: 0, error: e?.message ?? String(e) });
        }
    }
    return out;
}

async function primarySource(query: string, opts: SearchInput, _host: SearchHost): Promise<SearchOutcome> {
    const citations: SearchCitation[] = [];
    const used: string[] = [];
    const skipped: { engine: string; reason: string }[] = [];
    const maxResults = opts.max_results ?? 10;

    for (const source of INSTITUTIONAL_SOURCES) {
        const adapter = institutionalAdapters.get(source.domain);
        if (!adapter) continue;
        const engine = `primary:${source.domain}`;
        if (!(await adapter.available().catch(() => false))) {
            skipped.push({ engine, reason: 'no local index (not harvested yet)' });
            continue;
        }
        try {
            const results = await adapter.search(query, { maxResults });
            citations.push(...results);
            used.push(engine);
        } catch (e: any) {
            skipped.push({ engine, reason: e?.message ?? String(e) });
        }
    }

    return {
        mode: 'resolve', query, generated: nowIso(), citations,
        enginesUsed: used, enginesSkipped: skipped,
        primaryDomainsTried: INSTITUTIONAL_SOURCES.map(s => s.domain),
        note: `Primary-source tier: searched the local institutional index (${INSTITUTIONAL_SOURCES.map(s => s.domain).join(', ') || 'no sources configured'}). Run harvestInstitutionalIndex() to populate it from sources you configure.`,
    };
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function runSearch(host: SearchHost, input: SearchInput): Promise<SearchOutcome> {
    const query = (input.query ?? '').trim();
    if (!query) throw new Error('missing query');
    const opts: SearchInput = {
        ...input,
        mode: input.mode ?? 'resolve',
        depth: input.depth ?? 'basic',
        freshness: input.freshness ?? 'any',
        max_results: Math.max(1, Math.min(20, Number(input.max_results) || 10)),
    };

    if (opts.site === 'primary') {
        return primarySource(query, opts, host);
    }
    if (opts.mode === 'federate') {
        const fed = await federate(query, { maxResults: opts.max_results });
        return {
            mode: 'federate', query, generated: nowIso(),
            citations: fed.citations.map(c => ({ ...c, jurisdiction: c.jurisdiction as Jurisdiction })),
            enginesUsed: Object.keys(fed.coverage).filter(k => fed.coverage[k] > 0),
            enginesSkipped: fed.errors.map(e => ({ engine: e.endpoint, reason: e.error })),
            note: `Federated open endpoints (union/coverage, not agreement): ${Object.entries(fed.coverage).map(([k, v]) => `${k}=${v}`).join(', ')}.`,
        };
    }
    if (opts.mode === 'corroborate') {
        return corroborate(query, opts, host);
    }
    return resolve(query, opts, host);
}

/** Known primary-source domains, for the tool to surface to the model. */
export function institutionalDomains(): Record<string, string> {
    return INSTITUTIONAL_DOMAINS;
}

/** Fresh API calls per engine this session (for the tool's footer). */
export function meterSnapshot(): Record<string, number> {
    return Object.fromEntries(meter.entries());
}
