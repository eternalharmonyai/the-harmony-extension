/**
 * Access diagnostics — why a fetch failed, and who can fix it.
 *
 * A bare `blocked` verdict is correct but useless: it tells a user that something is wrong
 * without telling them whether the cause is their VPN exit, their country, a challenge that
 * needs a human, or a site that is simply down. Those have completely different remedies,
 * and only some of them are the AI's to attempt.
 *
 * THE AI/HUMAN SPLIT IS THE POINT
 * Every cause carries an `actor`. Where it is `human`, the AI states the situation and
 * stops — it does not solve challenges, and it does not rotate identity to get around a
 * refusal. Handing control back is not a limitation; it is what keeps the session honest.
 *
 * NOTE ON VPN SWITCHING
 * A human choosing a different VPN exit is not evasion: they remain the same person,
 * honestly presented, changing their network path. Automated rotation is evasion, because
 * its purpose is to appear to be many people. The distinction is agency and intent, and it
 * is why `vpn-exit-blocked` is always `actor: 'human'` — never something the tool retries
 * its way around.
 *
 * CONTROL PROBE
 * "The site refuses me" and "my network is broken" look identical from one failed request.
 * Diagnosis therefore differentiates against a control host rather than guessing, in the
 * same spirit as differential retrieval: one observation is an anecdote, two are evidence.
 *
 * Host-agnostic: no imports, web-standard `fetch` only.
 */

export type AccessCause =
    | 'ok'
    | 'captcha-challenge'
    | 'vpn-exit-blocked'
    | 'geo-restricted'
    | 'rate-limited'
    | 'auth-required'
    | 'site-outage'
    | 'dns-failure'
    | 'tls-failure'
    | 'network-unreachable'
    | 'not-found'
    | 'unknown';

/** Who can act. `human` causes are never retried around by the tool. */
export type Actor = 'ai' | 'human' | 'none';

export type Confidence = 'high' | 'medium' | 'low';

export interface AccessDiagnostic {
    cause: AccessCause;
    actor: Actor;
    /** Fixed vocabulary, never model-generated prose — see the diagnostics rule. */
    remedy: string;
    /** What was actually observed. A diagnosis without evidence is a guess with a label. */
    evidence: string[];
    confidence: Confidence;
    httpStatus?: number;
    headers?: Record<string, string>;
    /** True when a control host was reachable, isolating site-specific refusal. */
    networkHealthy?: boolean;
}

const REMEDY: Record<AccessCause, string> = {
    'ok': 'no action needed',
    'captcha-challenge': 'a human must complete the challenge in a browser; the tool will not attempt it',
    'vpn-exit-blocked': 'this exit IP is refused — a human can switch VPN exit or disconnect, then retry',
    'geo-restricted': 'the site restricts this region; a human decides whether a different lawful route exists',
    'rate-limited': 'back off and retry after the stated interval',
    'auth-required': 'credentials are needed; the tool does not authenticate on your behalf',
    'site-outage': 'the site is failing for everyone — retry later',
    'dns-failure': 'the host name did not resolve; check the spelling or your DNS',
    'tls-failure': 'the TLS handshake failed; a human should inspect before trusting this host',
    'network-unreachable': 'no route to the host from this network',
    'not-found': 'the resource is gone — try an archive',
    'unknown': 'unclassified failure; the evidence below is what was observed',
};

const ACTOR: Record<AccessCause, Actor> = {
    'ok': 'none',
    'captcha-challenge': 'human',
    'vpn-exit-blocked': 'human',
    'geo-restricted': 'human',
    'rate-limited': 'ai',
    'auth-required': 'human',
    'site-outage': 'ai',
    'dns-failure': 'human',
    'tls-failure': 'human',
    'network-unreachable': 'human',
    'not-found': 'ai',
    'unknown': 'human',
};

const CHALLENGE_MARKERS = [
    /just a moment/i, /cf-browser-verification/i, /checking your browser/i,
    /enable javascript and cookies to continue/i, /attention required/i,
    /verify you are (a )?human/i, /unusual traffic from your computer network/i,
    /recaptcha|hcaptcha|turnstile/i,
];

/** Phrases sites use when the refusal is about WHERE you are, not WHO you are. */
const GEO_MARKERS = [
    /not available in your (country|region|location)/i,
    /unavailable in your (country|region)/i,
    /for legal reasons/i, /due to (gdpr|legal|regulatory)/i,
    /this content is not available in/i,
];

const INTERESTING_HEADERS = [
    'cf-ray', 'cf-mitigated', 'retry-after', 'server', 'content-type',
    'www-authenticate', 'x-frame-options', 'location',
];

function collectHeaders(res: { headers: { get(k: string): string | null } }): Record<string, string> {
    const out: Record<string, string> = {};
    for (const h of INTERESTING_HEADERS) {
        const v = res.headers.get(h);
        if (v) out[h] = v;
    }
    return out;
}

function build(cause: AccessCause, evidence: string[], extra: Partial<AccessDiagnostic> = {}): AccessDiagnostic {
    return {
        cause, actor: ACTOR[cause], remedy: REMEDY[cause],
        evidence, confidence: 'medium', ...extra,
    };
}

/**
 * Classify a completed response. Body is optional — pass it when available, since a 200
 * carrying a challenge page is invisible from status and headers alone.
 */
export function classifyResponse(
    res: { status: number; headers: { get(k: string): string | null } },
    body?: string
): AccessDiagnostic {
    const headers = collectHeaders(res);
    const status = res.status;
    const ev: string[] = [`HTTP ${status}`];
    for (const [k, v] of Object.entries(headers)) ev.push(`${k}: ${v.slice(0, 80)}`);

    const challenged = !!body && CHALLENGE_MARKERS.some(re => re.test(body));
    const geo = !!body && GEO_MARKERS.some(re => re.test(body));

    // A challenge can arrive under 200, 403 or 503 — status alone misses it.
    if (challenged) {
        ev.push('body matches a bot-challenge signature');
        return build('captcha-challenge', ev, { httpStatus: status, headers, confidence: 'high' });
    }
    if (status === 451) {
        return build('geo-restricted', ev, { httpStatus: status, headers, confidence: 'high' });
    }
    if (geo) {
        ev.push('body states regional unavailability');
        return build('geo-restricted', ev, { httpStatus: status, headers, confidence: 'high' });
    }
    if (status === 429) {
        return build('rate-limited', ev, { httpStatus: status, headers, confidence: 'high' });
    }
    if (status === 401 || headers['www-authenticate']) {
        return build('auth-required', ev, { httpStatus: status, headers, confidence: 'high' });
    }
    if (status === 403) {
        // 403 behind a CDN is far more often IP reputation than a considered refusal.
        const cdn = !!headers['cf-ray'] || /cloudflare|akamai|fastly/i.test(headers['server'] ?? '');
        if (cdn) ev.push('403 served by a CDN edge — typical of IP or exit-node reputation');
        return build(cdn ? 'vpn-exit-blocked' : 'auth-required', ev, {
            httpStatus: status, headers, confidence: cdn ? 'medium' : 'low',
        });
    }
    if (status === 404 || status === 410) {
        return build('not-found', ev, { httpStatus: status, headers, confidence: 'high' });
    }
    if (status >= 500) {
        return build('site-outage', ev, { httpStatus: status, headers, confidence: 'high' });
    }
    if (status >= 200 && status < 300) {
        return build('ok', ev, { httpStatus: status, headers, confidence: 'high' });
    }
    return build('unknown', ev, { httpStatus: status, headers, confidence: 'low' });
}

/** Classify a thrown network error, where there is no response to inspect. */
export function classifyError(err: unknown): AccessDiagnostic {
    const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string } };
    const code = e?.code ?? e?.cause?.code ?? '';
    const msg = e?.message ?? String(err);
    const ev = [`error: ${msg.slice(0, 140)}`];
    if (code) ev.push(`code: ${code}`);

    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(code + msg)) return build('dns-failure', ev, { confidence: 'high' });
    if (/CERT|SSL|TLS|self.signed|DEPTH_ZERO/i.test(code + msg)) return build('tls-failure', ev, { confidence: 'high' });
    // undici (Node's fetch) reports UND_ERR_* rather than POSIX codes, and a non-resolving
    // host can surface as a connect timeout rather than ENOTFOUND. Matching only POSIX
    // names left real failures classified `unknown`, which is the least useful answer.
    if (/UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ConnectTimeout|TimeoutError|aborted/i.test(code + msg + (e?.name ?? ''))) {
        return build('network-unreachable', ev, { confidence: 'medium' });
    }
    return build('unknown', ev, { confidence: 'low' });
}

/**
 * Control hosts used to separate "this site refuses me" from "my network is broken".
 * Deliberately boring, widely-mirrored endpoints that exist to be probed.
 */
export const CONTROL_URLS = [
    'https://example.com/',
    'https://www.wikipedia.org/',
];

export interface DiagnoseOptions {
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    timeoutMs?: number;
    userAgent?: string;
    /** Spend one extra request to isolate network-wide failure from site-specific refusal. */
    useControlProbe?: boolean;
}

async function reachable(url: string, opts: DiagnoseOptions): Promise<boolean> {
    const doFetch = opts.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
    try {
        const res = await doFetch(url, {
            headers: { 'User-Agent': opts.userAgent ?? 'Harmony-Search/0.1' },
            signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
        return res.status < 500;
    } catch {
        return false;
    }
}

/**
 * Fetch a URL and diagnose the outcome. Never throws — a failure is a diagnosis, which is
 * the entire point of the module.
 */
export async function diagnoseAccess(url: string, opts: DiagnoseOptions = {}): Promise<AccessDiagnostic> {
    const doFetch = opts.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
    let diag: AccessDiagnostic;
    try {
        const res = await doFetch(url, {
            redirect: 'follow',
            headers: { 'User-Agent': opts.userAgent ?? 'Harmony-Search/0.1' },
            signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        });
        let body: string | undefined;
        try { body = (await res.text()).slice(0, 20_000); } catch { /* body optional */ }
        diag = classifyResponse(res, body);
    } catch (e) {
        diag = classifyError(e);
    }

    if (diag.cause === 'ok' || !opts.useControlProbe) return diag;

    // Differentiate: if a control host answers, the network is fine and the refusal is
    // specific to this site. If nothing answers, blaming the site would be wrong.
    const healthy = await reachable(CONTROL_URLS[0], opts);
    diag.networkHealthy = healthy;
    if (healthy) {
        diag.evidence.push('control host reachable — the network is up, so this refusal is site-specific');
        if (diag.cause === 'network-unreachable') {
            diag.evidence.push('reclassified: the network works, so this host specifically is unreachable');
            diag.confidence = 'medium';
        }
    } else {
        diag.evidence.push('control host also unreachable — this looks network-wide, not site-specific');
        // Do not blame a site for a failure that is happening everywhere.
        if (diag.cause === 'vpn-exit-blocked' || diag.cause === 'site-outage') {
            diag.cause = 'network-unreachable';
            diag.actor = ACTOR['network-unreachable'];
            diag.remedy = REMEDY['network-unreachable'];
            diag.confidence = 'low';
        }
    }
    return diag;
}

/** One-line summary for a HUD or tool output. */
export function formatDiagnostic(d: AccessDiagnostic): string {
    const who = d.actor === 'human' ? 'HUMAN' : d.actor === 'ai' ? 'AI' : '—';
    return `${d.cause} [${d.confidence}] · ${who}: ${d.remedy}`;
}
