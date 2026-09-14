/**
 * Source discovery and harvest preflight.
 *
 * WHY THIS REPLACES THE CURATED LIST
 * A hand-picked set of institutional sources is Harmony deciding what is worth indexing —
 * a small, benevolent version of the thing this project objects to elsewhere. It helps one
 * kind of research and no other, it does not scale, and it needs a maintainer forever.
 * So the product is the HARVESTER, not the library: point it at any domain, and it reports
 * what is harvestable and under what terms. The UN entries become README examples.
 *
 * Discovery probes only endpoints that exist to be consumed programmatically — OAI-PMH,
 * sitemaps, feeds, OpenSearch descriptors. When a site publishes one of these, harvesting
 * it is sanctioned rather than tolerated, which is the distinction that made the DDG floor
 * untenable and the UN OAI feed fine.
 *
 * SAFETY IS STRUCTURAL, NOT DISCLAIMED
 * The four things that actually cause trouble are redistribution, volume, evasion and
 * auth-bypass. Preflight addresses volume (a stated request budget and rate before anything
 * runs) and refuses the evasion and auth cases outright. Redistribution is handled a layer
 * up by hash-only records. None of this is legal advice; it is a set of defaults chosen so
 * that the safe path is also the easy one.
 *
 * Host-agnostic: no imports, web-standard `fetch` only.
 */

export type SourceKind = 'oai-pmh' | 'sitemap' | 'rss' | 'atom' | 'opensearch';

export interface DiscoveredSource {
    kind: SourceKind;
    endpoint: string;
    label: string;
    /** The evidence we actually saw. A claim of harvestability must be checkable. */
    evidence: string;
}

export interface RobotsSummary {
    fetched: boolean;
    crawlDelayMs: number;
    disallowCount: number;
    disallowsRoot: boolean;
    sitemaps: string[];
}

export interface HarvestPlan {
    estimatedRequests: number;
    delayMs: number;
    estimatedSeconds: number;
}

export type Recommendation = 'sanctioned' | 'caution' | 'refuse';

export interface HarvestPreflight {
    domain: string;
    origin: string;
    reachable: boolean;
    robots: RobotsSummary;
    sources: DiscoveredSource[];
    termsUrls: string[];
    plan?: HarvestPlan;
    findings: string[];
    blockers: string[];
    recommendation: Recommendation;
}

const UA = 'Harmony-Search/0.1 (source-discovery; +https://github.com/harmony)';
const TIMEOUT_MS = 12_000;
const DEFAULT_DELAY_MS = 1_000;

const OAI_PATHS = ['/oai', '/oai2', '/oai2d', '/oai/request', '/server/oai/request',
    '/cgi/oai2', '/oai-pmh', '/dspace-oai/request'];
const SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemaps.xml'];
const FEED_PATHS = ['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml', '/feeds/all.atom.xml'];
const OPENSEARCH_PATHS = ['/opensearch.xml', '/osd.xml', '/search/opensearch.xml'];

const CHALLENGE = /just a moment|cf-browser-verification|checking your browser|enable javascript and cookies/i;

interface Probe { status: number; body: string; challenged: boolean; ok: boolean }

async function probe(url: string, maxBytes = 8192): Promise<Probe | undefined> {
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': UA },
            redirect: 'follow',
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const text = (await res.text()).slice(0, maxBytes);
        return { status: res.status, body: text, challenged: CHALLENGE.test(text), ok: res.ok };
    } catch {
        return undefined;
    }
}

export function summarizeRobots(text: string): RobotsSummary {
    const s: RobotsSummary = {
        fetched: true, crawlDelayMs: DEFAULT_DELAY_MS,
        disallowCount: 0, disallowsRoot: false, sitemaps: [],
    };
    let wildcard = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const field = line.slice(0, i).trim().toLowerCase();
        const value = line.slice(i + 1).trim();
        if (field === 'sitemap') { s.sitemaps.push(value); continue; }
        if (field === 'user-agent') { wildcard = value === '*'; continue; }
        if (!wildcard) continue;
        if (field === 'disallow' && value) {
            s.disallowCount++;
            if (value === '/') s.disallowsRoot = true;
        }
        if (field === 'crawl-delay') {
            const secs = Number(value);
            if (Number.isFinite(secs) && secs > 0) s.crawlDelayMs = Math.ceil(secs * 1000);
        }
    }
    return s;
}

/** Links a site publishes describing its own terms. Surfaced, never interpreted. */
function findTermsLinks(html: string, origin: string): string[] {
    const out = new Set<string>();
    for (const m of html.matchAll(/href="([^"]*(?:terms|tos|legal|copyright|conditions)[^"]*)"/gi)) {
        try { out.add(new URL(m[1], origin).toString()); } catch { /* skip */ }
        if (out.size >= 3) break;
    }
    return [...out];
}

/**
 * Probe a domain for endpoints published for programmatic consumption.
 * Never throws: an unreachable or hostile host is a result, not an exception.
 */
export async function discoverSources(domain: string): Promise<HarvestPreflight> {
    const origin = /^https?:\/\//i.test(domain) ? domain.replace(/\/+$/, '') : `https://${domain}`;
    const host = (() => { try { return new URL(origin).hostname; } catch { return domain; } })();

    const out: HarvestPreflight = {
        domain: host, origin, reachable: false,
        robots: { fetched: false, crawlDelayMs: DEFAULT_DELAY_MS, disallowCount: 0, disallowsRoot: false, sitemaps: [] },
        sources: [], termsUrls: [], findings: [], blockers: [], recommendation: 'refuse',
    };

    // 1. Root — reachability, challenge detection, terms links.
    const root = await probe(origin, 40_000);
    if (!root) {
        out.blockers.push('host is unreachable from this network — not evidence that it refuses harvesting');
        return out;
    }
    out.reachable = true;
    if (root.challenged) {
        out.blockers.push('bot challenge served at the root; solving or evading it is out of scope by policy');
    }
    if (root.status === 401 || root.status === 403) {
        out.blockers.push(`root returned ${root.status} — this network cannot see the site`);
    }
    out.termsUrls = findTermsLinks(root.body, origin);

    // 2. robots.txt — honoured, not merely read.
    const robots = await probe(`${origin}/robots.txt`, 40_000);
    if (robots?.ok) {
        out.robots = summarizeRobots(robots.body);
        if (out.robots.disallowsRoot) {
            out.blockers.push('robots.txt disallows "/" for all agents — the site has asked not to be crawled');
        }
        out.findings.push(
            `robots.txt: crawl-delay ${out.robots.crawlDelayMs / 1000}s, ` +
            `${out.robots.disallowCount} disallow rule(s), ${out.robots.sitemaps.length} sitemap(s) declared`
        );
    } else {
        out.findings.push('no robots.txt — defaulting to a conservative 1s delay');
    }

    // 3. OAI-PMH: a repository protocol whose entire purpose is being harvested.
    for (const path of OAI_PATHS) {
        const r = await probe(`${origin}${path}?verb=Identify`);
        if (r?.ok && /<OAI-PMH/i.test(r.body)) {
            const name = /<repositoryName>([\s\S]*?)<\/repositoryName>/.exec(r.body)?.[1]?.trim();
            out.sources.push({
                kind: 'oai-pmh', endpoint: `${origin}${path}`,
                label: name || 'OAI-PMH repository',
                evidence: `verb=Identify returned an OAI-PMH envelope${name ? ` for "${name}"` : ''}`,
            });
            break;
        }
    }

    // 3b. Sibling hosts. Repositories very often live at export./api./data. — arXiv serves
    // OAI-PMH from export.arxiv.org as well as arxiv.org. Cheap to check, and the
    // alternative is telling a user "nothing here" about a host that publishes plenty.
    if (out.sources.length === 0) {
        const bare = host.replace(/^www\./, '');
        for (const prefix of ['export', 'api', 'data']) {
            const sibling = `https://${prefix}.${bare}`;
            const r = await probe(`${sibling}/oai2?verb=Identify`);
            if (r?.ok && /<OAI-PMH/i.test(r.body)) {
                const name = /<repositoryName>([\s\S]*?)<\/repositoryName>/.exec(r.body)?.[1]?.trim();
                out.sources.push({
                    kind: 'oai-pmh', endpoint: `${sibling}/oai2`,
                    label: name || 'OAI-PMH repository (sibling host)',
                    evidence: `found on sibling host ${sibling}, not on ${host}`,
                });
                break;
            }
        }
    }

    // 4. Sitemaps — declared in robots first, then conventional paths.
    const sitemapCandidates = out.robots.sitemaps.length
        ? out.robots.sitemaps.slice(0, 2)
        : SITEMAP_PATHS.map(p => origin + p);
    for (const url of sitemapCandidates) {
        const r = await probe(url);
        if (r?.ok && /<(urlset|sitemapindex)/i.test(r.body)) {
            out.sources.push({
                kind: 'sitemap', endpoint: url, label: 'XML sitemap',
                evidence: /<sitemapindex/i.test(r.body) ? 'sitemap index' : 'urlset',
            });
            break;
        }
    }

    // 5. Feeds — published for consumption, so no ToS ambiguity at all.
    const declared = [...root.body.matchAll(
        /<link[^>]+type="application\/(rss\+xml|atom\+xml)"[^>]*href="([^"]+)"/gi)]
        .map(m => { try { return new URL(m[2], origin).toString(); } catch { return undefined; } })
        .filter((u): u is string => !!u);
    for (const url of [...declared, ...FEED_PATHS.map(p => origin + p)].slice(0, 6)) {
        const r = await probe(url);
        if (r?.ok && /<rss|<feed[\s>]/i.test(r.body)) {
            const isAtom = /<feed[\s>]/i.test(r.body);
            out.sources.push({
                kind: isAtom ? 'atom' : 'rss', endpoint: url,
                label: isAtom ? 'Atom feed' : 'RSS feed',
                evidence: 'feed document returned; feeds are published for consumption',
            });
            break;
        }
    }

    // 6. OpenSearch — a site describing its own search interface.
    const osDeclared = /<link[^>]+type="application\/opensearchdescription\+xml"[^>]*href="([^"]+)"/i
        .exec(root.body)?.[1];
    const osCandidates = osDeclared
        ? [new URL(osDeclared, origin).toString()]
        : OPENSEARCH_PATHS.map(p => origin + p);
    for (const url of osCandidates) {
        const r = await probe(url);
        if (r?.ok && /<OpenSearchDescription/i.test(r.body)) {
            out.sources.push({
                kind: 'opensearch', endpoint: url, label: 'OpenSearch descriptor',
                evidence: 'site publishes its own search interface description',
            });
            break;
        }
    }

    // 7. Verdict.
    if (out.blockers.length > 0) {
        out.recommendation = 'refuse';
    } else if (out.sources.length > 0) {
        out.recommendation = 'sanctioned';
        out.findings.push(
            `${out.sources.length} endpoint(s) published for programmatic use — harvesting these is ` +
            'sanctioned access, not tolerated scraping'
        );
    } else {
        out.recommendation = 'caution';
        out.findings.push(
            'no published endpoint found AT THIS HOST on the paths probed. That is not evidence none ' +
            'exists: probing only finds what it looks for, endpoints often live on a sibling host ' +
            '(export.<domain>, api.<domain>, data.<domain>), and a site may document one nowhere ' +
            'conventional. Check the site\'s developer docs before concluding there is nothing.'
        );
        out.findings.push(
            'harvesting without one means fetching HTML directly — legal in most places for public ' +
            'pages at low rate, but unsanctioned, and worth a deliberate decision rather than a default'
        );
    }
    return out;
}

/**
 * Turn a preflight into a stated plan. The request budget is a promise to the operator,
 * so the limiter must be built from this number rather than the number merely displayed.
 */
export function planHarvest(pre: HarvestPreflight, maxRecords = 500): HarvestPlan {
    const perPage = pre.sources[0]?.kind === 'oai-pmh' ? 100 : 50;
    const estimatedRequests = Math.max(1, Math.ceil(maxRecords / perPage)) + 2; // + robots, discovery
    const delayMs = Math.max(pre.robots.crawlDelayMs, DEFAULT_DELAY_MS);
    return {
        estimatedRequests, delayMs,
        estimatedSeconds: Math.ceil((estimatedRequests - 1) * delayMs / 1000),
    };
}

/** Human-readable preflight, for the confirmation the user actually reads. */
export function formatPreflight(pre: HarvestPreflight, plan?: HarvestPlan): string {
    const L: string[] = [];
    const verdict = { sanctioned: 'SANCTIONED', caution: 'CAUTION', refuse: 'REFUSE' }[pre.recommendation];
    L.push(`Harvest preflight — ${pre.domain}   [${verdict}]`, '');

    if (pre.sources.length) {
        L.push('Published endpoints found:');
        for (const s of pre.sources) L.push(`  ${s.kind.padEnd(10)} ${s.endpoint}`, `             ${s.evidence}`);
    } else {
        L.push('Published endpoints found: none on the paths probed at this host');
    }
    L.push('');
    for (const f of pre.findings) L.push(`  note     ${f}`);
    for (const b of pre.blockers) L.push(`  BLOCKER  ${b}`);
    if (pre.termsUrls.length) {
        L.push('', 'Terms the site publishes (read before deciding — not interpreted here):');
        for (const t of pre.termsUrls) L.push(`  ${t}`);
    }
    if (plan) {
        L.push('', `Plan: ~${plan.estimatedRequests} requests, ${plan.delayMs / 1000}s apart, ` +
            `about ${plan.estimatedSeconds}s total.`);
    }
    if (pre.recommendation === 'refuse') {
        L.push('', 'Harvest will not proceed. This is a refusal, not a claim about legality.');
    }
    return L.join('\n');
}
