/**
 * Custom endpoint configuration — user-declared sources, without code changes.
 *
 * Sovereignty means a user can point Harmony at repositories and engines the project has
 * never heard of: a university OAI-PMH repository, a self-hosted SearXNG, a regional or
 * proxied provider endpoint. This module parses and validates that declaration.
 *
 * Host-agnostic: no `vscode`, no npm packages, no file I/O — callers supply the JSON text.
 *
 * TWO SAFETY RULES, and they pull in opposite directions on purpose:
 *
 * 1. PRIVATE ADDRESSES ARE ALLOWED, BUT ONLY DELIBERATELY. Unlike the MCP server — where a
 *    remote caller supplies the URL and loopback must be refused outright — this config is
 *    written by the user for their own machine, and "http://127.0.0.1:8888" is the single
 *    most likely self-hosted SearXNG address. Refusing it would break the main sovereignty
 *    use case. So private targets are permitted, but require `allow_private: true` on that
 *    endpoint: deliberate, visible, never silent.
 *
 * 2. NEVER INLINE A SECRET. Config files get committed and mirrored. An endpoint names a
 *    secret via `api_key_ref` (a Secret Storage key or env var NAME); a value that looks
 *    like an actual credential is REJECTED, because a rejected config is recoverable and a
 *    leaked key is not.
 */

export type EndpointJurisdiction =
    | 'US' | 'CN' | 'RU' | 'EU' | 'independent' | 'institutional' | 'unknown';

export interface CustomInstitutionalSource {
    domain: string;
    label: string;
    strategy: 'oai-pmh' | 'sitemap';
    endpoint?: string;
    origin?: string;
    metadataPrefix?: string;
    jurisdiction: EndpointJurisdiction;
    allow_private: boolean;
}

export interface CustomEngine {
    id: string;
    label: string;
    kind: 'searxng' | 'openai-compatible' | 'opensearch' | 'custom';
    baseUrl: string;
    jurisdiction: EndpointJurisdiction;
    /** NAME of a secret, never a secret. */
    api_key_ref?: string;
    /** Declared politeness budget; the real limiter must stay at or below it. */
    expected_requests_per_minute?: number;
    allow_private: boolean;
}

export interface EndpointConfig {
    version: 1;
    institutional: CustomInstitutionalSource[];
    engines: CustomEngine[];
}

export interface ConfigProblem {
    /** Dotted path to the offending value, e.g. `engines[0].baseUrl`. */
    where: string;
    problem: string;
    severity: 'error' | 'warning';
}

export interface ParseResult {
    config: EndpointConfig;
    problems: ConfigProblem[];
    /** True when no `error`-severity problem was found. */
    ok: boolean;
}

const JURISDICTIONS: EndpointJurisdiction[] = [
    'US', 'CN', 'RU', 'EU', 'independent', 'institutional', 'unknown',
];
const STRATEGIES = ['oai-pmh', 'sitemap'];
const ENGINE_KINDS = ['searxng', 'openai-compatible', 'opensearch', 'custom'];

// ─── Address classification ─────────────────────────────────────────────────

export function isPrivateHost(host: string): boolean {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::') return true;
    if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 0 || a === 10
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168);
}

// ─── Secret detection ───────────────────────────────────────────────────────

/**
 * Heuristics for "this looks like a credential, not a name". Deliberately eager: a false
 * positive costs the user a rename, a false negative costs them a leaked key in git.
 */
export function looksLikeSecret(value: string): boolean {
    const v = value.trim();
    if (/^(sk|pk|rk|api|key|tok|ghp|gho|xox|hf)[-_]/i.test(v)) return true;
    // Vendor prefixes that carry no separator: Google API keys and OAuth tokens.
    if (/^(AIza|ya29\.)/.test(v)) return true;
    if (/^[A-Fa-f0-9]{32,}$/.test(v)) return true;              // long hex
    if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(v)) return true;      // long base64
    if (/^ey[A-Za-z0-9_-]{10,}\./.test(v)) return true;         // JWT
    if (v.length > 48) return true;                              // no sane env var name is this long
    // Entropy shape: long, mixed case AND digits. Real reference names are either
    // UPPER_SNAKE (no lowercase) or short dotted paths, so neither trips this.
    if (v.length >= 24 && /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v)) return true;
    return false;
}

// ─── Validation ─────────────────────────────────────────────────────────────

function checkUrl(
    raw: unknown, where: string, allowPrivate: boolean, problems: ConfigProblem[]
): string | undefined {
    if (typeof raw !== 'string' || !raw.trim()) {
        problems.push({ where, problem: 'must be a non-empty URL string', severity: 'error' });
        return undefined;
    }
    let u: URL;
    try { u = new URL(raw); } catch {
        problems.push({ where, problem: `not a valid URL: ${raw}`, severity: 'error' });
        return undefined;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        problems.push({ where, problem: `only http(s) is supported (got ${u.protocol})`, severity: 'error' });
        return undefined;
    }
    if (isPrivateHost(u.hostname) && !allowPrivate) {
        problems.push({
            where,
            problem: `${u.hostname} is a private or loopback address. This is allowed for ` +
                     'self-hosted endpoints, but set "allow_private": true on this entry to ' +
                     'confirm you meant it.',
            severity: 'error',
        });
        return undefined;
    }
    if (u.protocol === 'http:' && !isPrivateHost(u.hostname)) {
        problems.push({
            where, severity: 'warning',
            problem: 'plaintext http to a public host: credentials and queries travel in the clear',
        });
    }
    return u.toString();
}

function checkJurisdiction(raw: unknown, where: string, problems: ConfigProblem[]): EndpointJurisdiction {
    if (typeof raw !== 'string' || !JURISDICTIONS.includes(raw as EndpointJurisdiction)) {
        problems.push({
            where, severity: 'warning',
            problem: `unknown jurisdiction ${JSON.stringify(raw)}; defaulting to "unknown". ` +
                     `Expected one of: ${JURISDICTIONS.join(', ')}`,
        });
        return 'unknown';
    }
    return raw as EndpointJurisdiction;
}

function checkSecretRef(raw: unknown, where: string, problems: ConfigProblem[]): string | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'string' || !raw.trim()) {
        problems.push({ where, problem: 'must be a string naming a secret', severity: 'error' });
        return undefined;
    }
    if (looksLikeSecret(raw)) {
        problems.push({
            where, severity: 'error',
            problem: 'this looks like an actual credential, not a name. Put the key in Secret ' +
                     'Storage or the environment and reference it by NAME here — config files ' +
                     'get committed and mirrored.',
        });
        return undefined;
    }
    return raw.trim();
}

/**
 * Parse and validate. Never throws, and always returns a usable config: invalid entries are
 * dropped with an explanation while valid ones survive. One bad endpoint must not cost the
 * user every other endpoint they declared.
 */
export function parseEndpointConfig(text: string): ParseResult {
    const problems: ConfigProblem[] = [];
    const config: EndpointConfig = { version: 1, institutional: [], engines: [] };

    let raw: any;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        problems.push({ where: '(document)', problem: `invalid JSON: ${(e as Error).message}`, severity: 'error' });
        return { config, problems, ok: false };
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        problems.push({ where: '(document)', problem: 'top level must be an object', severity: 'error' });
        return { config, problems, ok: false };
    }
    if (raw.version !== 1) {
        problems.push({
            where: 'version', severity: 'error',
            problem: `unsupported config version ${JSON.stringify(raw.version)}; expected 1`,
        });
        return { config, problems, ok: false };
    }

    const seenDomains = new Set<string>();
    for (const [i, entry] of (Array.isArray(raw.institutional) ? raw.institutional : []).entries()) {
        const at = `institutional[${i}]`;
        if (entry === null || typeof entry !== 'object') {
            problems.push({ where: at, problem: 'must be an object', severity: 'error' });
            continue;
        }
        const before = problems.length;
        const allowPrivate = entry.allow_private === true;

        const domain = typeof entry.domain === 'string' ? entry.domain.trim().toLowerCase() : '';
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
            problems.push({ where: `${at}.domain`, problem: `not a valid domain: ${JSON.stringify(entry.domain)}`, severity: 'error' });
        } else if (seenDomains.has(domain)) {
            problems.push({ where: `${at}.domain`, problem: `duplicate domain "${domain}"`, severity: 'error' });
        }
        const strategy = entry.strategy;
        if (!STRATEGIES.includes(strategy)) {
            problems.push({ where: `${at}.strategy`, problem: `must be one of: ${STRATEGIES.join(', ')}`, severity: 'error' });
        }

        let endpoint: string | undefined;
        let origin: string | undefined;
        if (strategy === 'oai-pmh') {
            endpoint = checkUrl(entry.endpoint, `${at}.endpoint`, allowPrivate, problems);
        } else if (strategy === 'sitemap') {
            origin = checkUrl(entry.origin, `${at}.origin`, allowPrivate, problems);
        }
        const jurisdiction = checkJurisdiction(entry.jurisdiction ?? 'institutional', `${at}.jurisdiction`, problems);

        if (problems.slice(before).some(p => p.severity === 'error')) continue;
        seenDomains.add(domain);
        config.institutional.push({
            domain, label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : domain,
            strategy, endpoint, origin,
            metadataPrefix: typeof entry.metadataPrefix === 'string' ? entry.metadataPrefix : undefined,
            jurisdiction, allow_private: allowPrivate,
        });
    }

    const seenIds = new Set<string>();
    for (const [i, entry] of (Array.isArray(raw.engines) ? raw.engines : []).entries()) {
        const at = `engines[${i}]`;
        if (entry === null || typeof entry !== 'object') {
            problems.push({ where: at, problem: 'must be an object', severity: 'error' });
            continue;
        }
        const before = problems.length;
        const allowPrivate = entry.allow_private === true;

        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) {
            problems.push({ where: `${at}.id`, problem: `not a valid engine id: ${JSON.stringify(entry.id)}`, severity: 'error' });
        } else if (seenIds.has(id)) {
            problems.push({ where: `${at}.id`, problem: `duplicate engine id "${id}"`, severity: 'error' });
        }
        if (!ENGINE_KINDS.includes(entry.kind)) {
            problems.push({ where: `${at}.kind`, problem: `must be one of: ${ENGINE_KINDS.join(', ')}`, severity: 'error' });
        }
        const baseUrl = checkUrl(entry.baseUrl, `${at}.baseUrl`, allowPrivate, problems);
        const jurisdiction = checkJurisdiction(entry.jurisdiction ?? 'unknown', `${at}.jurisdiction`, problems);
        const apiKeyRef = checkSecretRef(entry.api_key_ref, `${at}.api_key_ref`, problems);

        let rpm: number | undefined;
        if (entry.expected_requests_per_minute !== undefined) {
            const n = entry.expected_requests_per_minute;
            if (!Number.isInteger(n) || n <= 0) {
                problems.push({ where: `${at}.expected_requests_per_minute`, problem: 'must be a positive integer', severity: 'error' });
            } else {
                rpm = n;
                if (n > 60) {
                    problems.push({
                        where: `${at}.expected_requests_per_minute`, severity: 'warning',
                        problem: `${n}/min is aggressive for a shared endpoint; this is a promise to the operator`,
                    });
                }
            }
        }

        if (problems.slice(before).some(p => p.severity === 'error')) continue;
        seenIds.add(id);
        config.engines.push({
            id, label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : id,
            kind: entry.kind, baseUrl: baseUrl!, jurisdiction,
            api_key_ref: apiKeyRef, expected_requests_per_minute: rpm, allow_private: allowPrivate,
        });
    }

    return { config, problems, ok: !problems.some(p => p.severity === 'error') };
}

/** Render problems for a human. Errors first — a warning after an error is noise. */
export function formatProblems(problems: ConfigProblem[]): string {
    if (problems.length === 0) return 'No problems found.';
    const order = { error: 0, warning: 1 } as const;
    return [...problems]
        .sort((a, b) => order[a.severity] - order[b.severity])
        .map(p => `${p.severity.toUpperCase().padEnd(7)} ${p.where}: ${p.problem}`)
        .join('\n');
}

/**
 * Shape a validated entry for institutionalIndex.ts's `InstitutionalSource`. Kept
 * structural rather than importing the type, so neither module depends on the other.
 */
export function toInstitutionalSources(config: EndpointConfig) {
    return config.institutional.map(s => ({
        domain: s.domain,
        label: s.label,
        strategy: s.strategy,
        endpoint: s.endpoint,
        origin: s.origin,
        metadataPrefix: s.metadataPrefix,
    }));
}
