/**
 * VPN-Resilient Zero-Leak HTTPS Transport for Gemini & Google Cloud Vertex AI
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Over encrypted full-tunnel VPNs (WireGuard, OpenVPN, IPSec), Google's `*.googleapis.com`
 * endpoints (`aiplatform.googleapis.com`, `generativelanguage.googleapis.com`,
 * `oauth2.googleapis.com`) exhibit four failure modes under Node's default `fetch` (`undici`)
 * that rarely affect CDN-clamped endpoints:
 *
 *   1. Tunnel MTU / PMTUD Blackholing on Large Uploads (`250 KB - 1.5 MB` tool+prompt JSON):
 *      Small handshakes (`< 1 KB`) succeed, while burst writes stall silently without TCP RST.
 *   2. Aggressive VPN Middlebox Idle Eviction (`30-60s`) & Tunnel Rebind Zombie Sockets:
 *      `undici` pools idle sockets without TCP `SO_KEEPALIVE` packets, and ignores the WHATWG-forbidden
 *      `Connection: close` header — causing 180s hangs (`4 x 180s = 730.4s`) on dead sockets.
 *   3. IPv6 (`AAAA`) Sinkholing Inside IPv4-Only VPN Tunnels:
 *      `*.googleapis.com` always advertises `AAAA` records; half-blocked IPv6 routes stall before
 *      trying IPv4 inside the tunnel.
 *   4. Frontier Reasoning TTFB vs. Dead-Socket Ambiguity:
 *      Healthy `gemini-4-carbon` steps on Vertex `global` legitimately think for `140s-179s`, so a
 *      single undifferentiated timeout either kills valid turns (if short) or hangs 12m on dead
 *      VPN sockets (if long).
 *
 * STRICT ZERO-LEAK INVARIANT
 * --------------------------
 *   - NEVER bypasses the OS VPN tunnel (`localAddress` is NEVER set; OS `dns.lookup` uses the
 *     VPN's encrypted DNS resolver).
 *   - NEVER bypasses proxy-mode VPNs: if `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, or an explicit
 *     editor `http.proxy` setting is active for the target URL, requests automatically delegate
 *     to the proxy-aware `fetch` path.
 *   - Remote TLS certificate verification (`rejectUnauthorized: true`) is strictly enforced for
 *     every non-loopback host.
 */

import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { Readable } from 'stream';
import * as tls from 'tls';
import * as zlib from 'zlib';

export type VpnTransportPhase = 'connect_tls' | 'upload_stall' | 'ttfb_timeout' | 'socket_error';

export class VpnTransportPhaseError extends Error {
    public readonly phase: VpnTransportPhase;
    public readonly code?: string;

    constructor(phase: VpnTransportPhase, message: string, cause?: unknown) {
        super(message);
        this.name = 'VpnTransportPhaseError';
        this.phase = phase;
        const causeCode = typeof (cause as any)?.code === 'string' ? (cause as any).code : undefined;
        if (causeCode) {
            this.code = causeCode;
        }
        if (cause !== undefined) {
            (this as any).cause = cause;
        }
    }
}

export interface VpnResilientFetchOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    signal?: AbortSignal;
    label?: string;
    /** Phase 1: DNS + TCP + TLS handshake timeout (default 15_000ms). */
    connectTimeoutMs?: number;
    /** Phase 2: Per-chunk upload progress watchdog timeout (default 30_000ms). */
    uploadTimeoutMs?: number;
    /** Phase 3: Post-upload wait for first HTTP response headers (default 180_000ms). */
    ttfbTimeoutMs?: number;
    /** OS TCP keep-alive probe interval while connected/thinking (default 15_000ms). */
    keepAliveInitialDelayMs?: number;
    /** Upload slice size in bytes (default 16_384 = 16 KB TLS record size). */
    uploadChunkBytes?: number;
    /** Bypass connection pool and open a brand-new TCP/TLS socket (`agent: false`). */
    forceFreshSocket?: boolean;
    /** Resolve & connect via IPv4 (`family: 4`) inside the OS/VPN routing table. */
    preferIpv4?: boolean;
    /** Automatically self-heal once on pre-header failure with fresh IPv4 socket (default true). */
    autoHealPreHeaderFailure?: boolean;
    /** Optional editor `http.proxy` setting to honor proxy-mode VPNs. */
    explicitProxySetting?: string;
    /** Optional editor `http.proxySupport` setting (`'off'` disables proxy delegation). */
    proxySupport?: string;
    /** Optional environment map (defaults to `process.env`). */
    env?: NodeJS.ProcessEnv;
    /** Optional injected `fetch` (for unit tests or explicit proxy delegation). */
    fetchImpl?: typeof fetch;
    /** Loopback-only (`127.0.0.1` / `localhost` / `::1`) test override; ignored for remote hosts. */
    tlsRejectUnauthorized?: boolean;
    /** Diagnostic/ledger callback invoked when a transport guard or self-heal fires (AGENTS.md §6). */
    onGuardEvent?: (reason: string) => void;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_TTFB_TIMEOUT_MS = 180_000;
const DEFAULT_KEEPALIVE_DELAY_MS = 15_000;
const DEFAULT_UPLOAD_CHUNK_BYTES = 16_384;
const FREE_SOCKET_IDLE_TTL_MS = 20_000;
const HOST_IPV4_DOWNGRADE_TTL_MS = 10 * 60 * 1000;
const INITIAL_GLOBAL_FETCH: typeof fetch | undefined = typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined;

const freeSocketTimers = new WeakMap< object, ReturnType<typeof setTimeout> >();
const hostFreshIpv4Until = new Map<string, number>();

function redactUrlSecrets(input: string): string {
    if (!input) return input;
    return input
        .replace(/([?&](?:key|access_token|refresh_token|client_secret|token)=)[^&#\s"']+/gi, '$1[REDACTED]')
        .replace(/(\b(?:access_token|refresh_token|client_secret)\s*["']?\s*[:=]\s*["']?)[^"'\s&#,}]+/gi, '$1[REDACTED]')
        .replace(/(\bBearer\s+)(?:ya29\.[A-Za-z0-9._~+/=-]+|eyJ[A-Za-z0-9._~+/=-]+|AIza[A-Za-z0-9_-]+|AQ\.[A-Za-z0-9._~+/=-]+|[A-Za-z0-9._~+/=-]{24,})/gi, '$1[REDACTED]')
        .replace(/(\bx-goog-api-key\s*["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]');
}

export function unwrapTransportErrorChain(err: unknown): string {
    const parts: string[] = [];
    let cur: any = err;
    let depth = 0;
    while (cur && depth < 5) {
        const code = typeof cur?.code === 'string' ? cur.code : '';
        const phase = typeof cur?.phase === 'string' ? `[${cur.phase}]` : '';
        const msg = typeof cur?.message === 'string' ? cur.message : (depth === 0 ? String(cur ?? '') : '');
        const label = [phase, code, msg].filter(Boolean).join(' ');
        if (label && !parts.includes(label)) {
            parts.push(label);
        }
        cur = cur?.cause;
        depth += 1;
    }
    return redactUrlSecrets(parts.join(' <- cause: '));
}

function clearFreeSocketTimer(sock: unknown): void {
    if (!sock || typeof sock !== 'object') return;
    const existing = freeSocketTimers.get(sock);
    if (existing) {
        clearTimeout(existing);
        freeSocketTimers.delete(sock);
    }
}

function createVpnSafeHttpsAgent(): https.Agent {
    const agent = new https.Agent({
        keepAlive: true,
        keepAliveMsecs: DEFAULT_KEEPALIVE_DELAY_MS,
        maxSockets: 16,
        maxFreeSockets: 4,
    });
    agent.on('free', (sock: any) => {
        clearFreeSocketTimer(sock);
        const reaper = setTimeout(() => {
            freeSocketTimers.delete(sock);
            try {
                sock.destroy();
            } catch { /* ignore */ }
        }, FREE_SOCKET_IDLE_TTL_MS);
        if (typeof reaper.unref === 'function') {
            reaper.unref();
        }
        freeSocketTimers.set(sock, reaper);
    });
    return agent;
}

let sharedVpnHttpsAgent: https.Agent | undefined;

function getSharedVpnHttpsAgent(): https.Agent {
    if (!sharedVpnHttpsAgent) {
        sharedVpnHttpsAgent = createVpnSafeHttpsAgent();
    }
    return sharedVpnHttpsAgent;
}

/**
 * Evicts ONLY idle free sockets from the shared pool and rotates the pool instance
 * so concurrent active in-flight streams are never disrupted.
 */
export function evictIdleVpnSockets(): number {
    let evicted = 0;
    const current = sharedVpnHttpsAgent;
    sharedVpnHttpsAgent = undefined;
    if (!current) return 0;
    const buckets = current.freeSockets as Record<string, any[] | undefined>;
    for (const key of Object.keys(buckets)) {
        const list = buckets[key];
        if (!Array.isArray(list)) continue;
        for (const sock of [...list]) {
            clearFreeSocketTimer(sock);
            try {
                sock.destroy();
                evicted += 1;
            } catch { /* ignore */ }
        }
        delete buckets[key];
    }
    return evicted;
}

export function markVpnHostPreferFreshIpv4(hostname: string, durationMs = HOST_IPV4_DOWNGRADE_TTL_MS): void {
    const clean = String(hostname ?? '').trim().toLowerCase();
    if (!clean) return;
    hostFreshIpv4Until.set(clean, Date.now() + Math.max(1_000, durationMs));
}

export function clearVpnHostPreferFreshIpv4(hostname: string): void {
    const clean = String(hostname ?? '').trim().toLowerCase();
    if (!clean) return;
    hostFreshIpv4Until.delete(clean);
}

export function shouldVpnHostPreferFreshIpv4(hostname: string, now = Date.now()): boolean {
    const clean = String(hostname ?? '').trim().toLowerCase();
    if (!clean) return false;
    const until = hostFreshIpv4Until.get(clean);
    if (!until) return false;
    if (now >= until) {
        hostFreshIpv4Until.delete(clean);
        return false;
    }
    return true;
}

export function resetVpnTransportStateForTests(): void {
    evictIdleVpnSockets();
    hostFreshIpv4Until.clear();
}

function hostMatchesNoProxy(hostname: string, port: string, noProxyRaw: string): boolean {
    const host = hostname.toLowerCase();
    const entries = noProxyRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    for (const entry of entries) {
        if (entry === '*') return true;
        const [entryHostRaw, entryPort] = entry.includes(':') && !entry.startsWith('[')
            ? entry.split(':', 2)
            : [entry, ''];
        if (entryPort && port && entryPort !== port) continue;
        const entryHost = entryHostRaw.replace(/^\.+/, '');
        if (!entryHost) continue;
        if (host === entryHost || host.endsWith(`.${entryHost}`)) {
            return true;
        }
    }
    return false;
}

/**
 * Returns true if an explicit HTTP/HTTPS/ALL proxy is configured for `targetUrl`
 * (and not excluded by `NO_PROXY`). When true, we delegate to proxy-aware `fetch`
 * so proxy-mode VPNs are NEVER bypassed.
 */
export function isExplicitProxyActiveForUrl(
    targetUrl: string,
    options?: { env?: NodeJS.ProcessEnv; explicitProxySetting?: string; proxySupport?: string }
): boolean {
    if ((options?.proxySupport ?? '').trim().toLowerCase() === 'off') {
        return false;
    }
    const env = options?.env ?? process.env;
    const explicitSetting = (options?.explicitProxySetting ?? '').trim();
    const envProxy = (
        env.HTTPS_PROXY ||
        env.https_proxy ||
        env.HTTP_PROXY ||
        env.http_proxy ||
        env.ALL_PROXY ||
        env.all_proxy ||
        ''
    ).trim();
    if (!explicitSetting && !envProxy) return false;

    try {
        const parsed = new URL(targetUrl);
        if (isLoopbackHostname(parsed.hostname)) {
            return false;
        }
        const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
        const noProxy = (env.NO_PROXY || env.no_proxy || '').trim();
        if (noProxy && hostMatchesNoProxy(parsed.hostname, port, noProxy)) {
            return false;
        }
    } catch {
        // Malformed URL — fail closed toward proxy-aware path
        return true;
    }
    return true;
}

export function isPreHeaderSelfHealableError(err: unknown, elapsedMs: number, maxElapsedMs = 45_000): boolean {
    if (elapsedMs > maxElapsedMs) return false;
    if (err instanceof VpnTransportPhaseError) {
        return err.phase === 'connect_tls' || err.phase === 'upload_stall' || err.phase === 'socket_error';
    }
    const text = unwrapTransportErrorChain(err);
    return /\bfetch failed\b|\beconnreset\b|\bepipe\b|\betimedout\b|\benetunreach\b|\behostunreach\b|\beaddrnotavail\b|\beconnrefused\b|\beai_again\b|\bsocket hang ?up\b|\bother side closed\b|\bterminated\b|\bund_err_(?:socket|closed|connect_timeout|headers_timeout)\b|connect\/tls handshake timed out|request upload stalled/i.test(text);
}

function isLoopbackHostname(hostname: string): boolean {
    const clean = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return clean === '127.0.0.1' || clean === 'localhost' || clean === '::1';
}

function wrapDecompressedStream(raw: http.IncomingMessage): Readable {
    const encoding = String(raw.headers['content-encoding'] ?? '').trim().toLowerCase();
    if (!encoding || encoding === 'identity') {
        return raw;
    }
    let decoder: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | undefined;
    if (encoding === 'gzip' || encoding === 'x-gzip') {
        decoder = zlib.createGunzip();
    } else if (encoding === 'deflate') {
        decoder = zlib.createInflate();
    } else if (encoding === 'br') {
        decoder = zlib.createBrotliDecompress();
    }
    if (!decoder) return raw;
    raw.on('error', (err) => decoder!.destroy(err));
    decoder.once('close', () => {
        if (!raw.destroyed && !raw.complete) {
            try { raw.destroy(); } catch { /* ignore */ }
        }
    });
    return raw.pipe(decoder);
}

async function executeProxyOrCustomFetch(
    url: string,
    options: VpnResilientFetchOptions
): Promise<Response> {
    const fetchFn = options.fetchImpl ?? fetch;
    const label = options.label || 'Gemini';
    const ttfbMs = options.ttfbTimeoutMs ?? DEFAULT_TTFB_TIMEOUT_MS;
    const autoHeal = options.autoHealPreHeaderFailure !== false;

    const runSingle = async (forceClose: boolean): Promise<Response> => {
        const attemptController = new AbortController();
        let timedOut = false;
        const timeoutMsg = `${label} request timed out before the first response bytes (${Math.round(ttfbMs / 1000)}s).`;
        const onOuterAbort = () => attemptController.abort(options.signal?.reason);
        if (options.signal) {
            if (options.signal.aborted) {
                attemptController.abort(options.signal.reason);
            } else {
                options.signal.addEventListener('abort', onOuterAbort, { once: true });
            }
        }
        const timer = setTimeout(() => {
            timedOut = true;
            attemptController.abort(new Error(timeoutMsg));
        }, ttfbMs);
        try {
            const mergedHeaders = forceClose
                ? { ...(options.headers ?? {}), Connection: 'close' }
                : (options.headers ?? {});
            return await fetchFn(url, {
                method: options.method ?? 'POST',
                headers: mergedHeaders,
                body: options.body as any,
                signal: attemptController.signal as any,
            });
        } catch (err: any) {
            if (timedOut && !options.signal?.aborted) {
                throw new VpnTransportPhaseError('ttfb_timeout', timeoutMsg, err);
            }
            const unwrapped = unwrapTransportErrorChain(err);
            if (unwrapped && unwrapped !== err?.message && !options.signal?.aborted) {
                throw new VpnTransportPhaseError('socket_error', `${label} fetch error: ${unwrapped}`, err);
            }
            throw err;
        } finally {
            clearTimeout(timer);
            if (options.signal) {
                options.signal.removeEventListener('abort', onOuterAbort);
            }
        }
    };

    const start = Date.now();
    try {
        return await runSingle(Boolean(options.forceFreshSocket));
    } catch (firstErr: any) {
        const elapsed = Date.now() - start;
        const unwrapped = unwrapTransportErrorChain(firstErr);
        const maxHealWindow = Math.min(45_000, Math.max(20_000, (options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS) + 5_000));
        if (
            autoHeal
            && !options.forceFreshSocket
            && !options.signal?.aborted
            && isPreHeaderSelfHealableError(firstErr, elapsed, maxHealWindow)
        ) {
            const healNote = `${label} stale keep-alive socket reset before headers (${unwrapped.slice(0, 160)}); retrying immediately on a fresh connection`;
            options.onGuardEvent?.(healNote);
            return await runSingle(true);
        }
        throw firstErr;
    }
}

async function executeNodeHttpAttempt(
    url: string,
    options: VpnResilientFetchOptions,
    forceFreshSocket: boolean,
    preferIpv4: boolean
): Promise<Response> {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    if (!isHttps && parsedUrl.protocol !== 'http:') {
        throw new Error(`Unsupported protocol "${parsedUrl.protocol}" for VPN-resilient transport.`);
    }

    const label = options.label || 'Gemini';
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    const ttfbTimeoutMs = options.ttfbTimeoutMs ?? DEFAULT_TTFB_TIMEOUT_MS;
    const keepAliveDelayMs = options.keepAliveInitialDelayMs ?? DEFAULT_KEEPALIVE_DELAY_MS;
    const chunkBytes = Math.max(1_024, options.uploadChunkBytes ?? DEFAULT_UPLOAD_CHUNK_BYTES);

    const method = (options.method ?? 'POST').toUpperCase();
    const bodyBuffer = options.body === undefined
        ? Buffer.alloc(0)
        : (Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body), 'utf8'));

    const isSseRequest = parsedUrl.searchParams.get('alt') === 'sse'
        || /text\/event-stream/i.test(String(options.headers?.['Accept'] ?? options.headers?.['accept'] ?? ''));

    const reqHeaders: Record<string, string> = { ...(options.headers ?? {}) };
    const hasContentLength = Object.keys(reqHeaders).some(k => k.toLowerCase() === 'content-length');
    if (!hasContentLength && (bodyBuffer.byteLength > 0 || method === 'POST' || method === 'PUT')) {
        reqHeaders['Content-Length'] = String(bodyBuffer.byteLength);
    }
    const hasAcceptEncoding = Object.keys(reqHeaders).some(k => k.toLowerCase() === 'accept-encoding');
    if (!hasAcceptEncoding) {
        reqHeaders['Accept-Encoding'] = isSseRequest ? 'identity' : 'gzip, deflate';
    }
    if (forceFreshSocket) {
        reqHeaders['Connection'] = 'close';
    }

    // Strict security invariant: never weaken remote certificate verification.
    const rejectUnauthorized = isLoopbackHostname(parsedUrl.hostname) && options.tlsRejectUnauthorized === false
        ? false
        : true;

    return await new Promise<Response>((resolve, reject) => {
        if (options.signal?.aborted) {
            const abortErr = new Error('This operation was aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
            return;
        }

        let settled = false;
        let responseReceived = false;
        let phase2Started = false;
        let phase3Started = false;
        let connectTimer: ReturnType<typeof setTimeout> | undefined;
        let uploadTimer: ReturnType<typeof setTimeout> | undefined;
        let ttfbTimer: ReturnType<typeof setTimeout> | undefined;
        let activeSocket: any = undefined;
        let drainWakeup: (() => void) | undefined;
        let activeDrainHandler: (() => void) | undefined;

        const clearAllPhaseTimers = () => {
            if (connectTimer) { clearTimeout(connectTimer); connectTimer = undefined; }
            if (uploadTimer) { clearTimeout(uploadTimer); uploadTimer = undefined; }
            if (ttfbTimer) { clearTimeout(ttfbTimer); ttfbTimer = undefined; }
        };

        const wakeDrainWaiter = () => {
            if (activeDrainHandler) {
                try { req.removeListener('drain', activeDrainHandler); } catch { /* ignore */ }
                activeDrainHandler = undefined;
            }
            if (drainWakeup) {
                const fn = drainWakeup;
                drainWakeup = undefined;
                fn();
            }
        };

        const recordHostHealOrClearOnPhaseFailure = (occurredBeforeHandshake: boolean) => {
            evictIdleVpnSockets();
            if (occurredBeforeHandshake && preferIpv4) {
                // Avoid locking IPv6-only / NAT64 networks into family:4 if IPv4 itself failed to connect
                clearVpnHostPreferFreshIpv4(parsedUrl.hostname);
            } else {
                markVpnHostPreferFreshIpv4(parsedUrl.hostname);
            }
        };

        const failAttempt = (err: Error) => {
            if (settled) return;
            settled = true;
            clearAllPhaseTimers();
            wakeDrainWaiter();
            if (options.signal) {
                options.signal.removeEventListener('abort', onAbortSignal);
            }
            try { req.destroy(); } catch { /* ignore */ }
            reject(err);
        };

        const cleanHostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
        const isIpLiteral = net.isIP(cleanHostname) !== 0;

        const reqOptions: https.RequestOptions = {
            protocol: parsedUrl.protocol,
            hostname: cleanHostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            method,
            headers: reqHeaders,
            agent: forceFreshSocket ? false : (isHttps ? getSharedVpnHttpsAgent() : undefined),
            ...(isHttps ? { rejectUnauthorized, servername: (isLoopbackHostname(cleanHostname) || isIpLiteral) ? undefined : cleanHostname } : {}),
            ...(isIpLiteral
                ? {}
                : preferIpv4
                    ? { family: 4 }
                    : { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 3_000 } as any),
        };

        const requestFn = isHttps ? https.request : http.request;
        const req = requestFn(reqOptions);

        // Attach 'error' handler IMMEDIATELY on req creation so synchronous/nextTick aborts or
        // destroys can never trigger an uncaught EventEmitter 'error' crash in Node v22+.
        req.on('error', (err: any) => {
            // Ignore write-side EPIPE/ECONNRESET if the server already delivered an early HTTP response (e.g. 401/413)
            if (responseReceived) return;
            recordHostHealOrClearOnPhaseFailure(!phase2Started);
            const unwrapped = unwrapTransportErrorChain(err);
            failAttempt(new VpnTransportPhaseError(
                'socket_error',
                `${label} fetch error: ${unwrapped}`,
                err
            ));
        });

        const onAbortSignal = () => {
            const abortErr = new Error('This operation was aborted');
            abortErr.name = 'AbortError';
            if (!settled) {
                failAttempt(abortErr);
            } else {
                try { req.destroy(abortErr); } catch { /* ignore */ }
            }
        };

        if (options.signal) {
            if (options.signal.aborted) {
                onAbortSignal();
                return;
            }
            options.signal.addEventListener('abort', onAbortSignal, { once: true });
        }

        const startPhase3TtfbGuard = () => {
            if (settled || responseReceived || phase3Started) return;
            phase3Started = true;
            if (uploadTimer) { clearTimeout(uploadTimer); uploadTimer = undefined; }
            const timeoutMsg = `${label} request timed out before the first response bytes (${Math.round(ttfbTimeoutMs / 1000)}s).`;
            ttfbTimer = setTimeout(() => {
                evictIdleVpnSockets();
                markVpnHostPreferFreshIpv4(parsedUrl.hostname);
                failAttempt(new VpnTransportPhaseError('ttfb_timeout', timeoutMsg));
            }, ttfbTimeoutMs);
        };

        const refreshUploadWatchdog = () => {
            if (settled || responseReceived) return;
            if (uploadTimer) clearTimeout(uploadTimer);
            uploadTimer = setTimeout(() => {
                evictIdleVpnSockets();
                markVpnHostPreferFreshIpv4(parsedUrl.hostname);
                failAttempt(new VpnTransportPhaseError(
                    'upload_stall',
                    `${label} request upload stalled after ${Math.round(uploadTimeoutMs / 1000)}s (VPN tunnel MTU blackhole or dead socket).`
                ));
            }, uploadTimeoutMs);
        };

        const runPacedBodyUpload = async () => {
            if (settled || responseReceived || phase2Started) return;
            phase2Started = true;
            if (connectTimer) { clearTimeout(connectTimer); connectTimer = undefined; }

            if (bodyBuffer.byteLength === 0) {
                req.end();
                startPhase3TtfbGuard();
                return;
            }

            refreshUploadWatchdog();
            try {
                let slicesSinceYield = 0;
                for (let offset = 0; offset < bodyBuffer.byteLength; offset += chunkBytes) {
                    if (settled || responseReceived || options.signal?.aborted) return;
                    const end = Math.min(offset + chunkBytes, bodyBuffer.byteLength);
                    const slice = bodyBuffer.subarray(offset, end);
                    const canContinue = req.write(slice);
                    refreshUploadWatchdog();
                    slicesSinceYield += 1;

                    if (!canContinue && !settled && !responseReceived) {
                        await new Promise<void>((resDrain) => {
                            const onDrain = () => {
                                activeDrainHandler = undefined;
                                if (drainWakeup === resDrain) drainWakeup = undefined;
                                resDrain();
                            };
                            drainWakeup = resDrain;
                            activeDrainHandler = onDrain;
                            req.once('drain', onDrain);
                        });
                        refreshUploadWatchdog();
                        slicesSinceYield = 0;
                    } else if (slicesSinceYield >= 4 && end < bodyBuffer.byteLength) {
                        slicesSinceYield = 0;
                        await new Promise<void>((resTick) => setImmediate(resTick));
                    }
                }

                if (settled || responseReceived) return;
                req.end(() => {
                    startPhase3TtfbGuard();
                });
                // If kernel socket has no buffered user-space bytes remaining, start Phase 3 immediately
                if (!activeSocket || (activeSocket.writableLength ?? 0) === 0) {
                    startPhase3TtfbGuard();
                }
            } catch (writeErr: any) {
                if (!responseReceived && !settled) {
                    evictIdleVpnSockets();
                    markVpnHostPreferFreshIpv4(parsedUrl.hostname);
                    failAttempt(new VpnTransportPhaseError(
                        'upload_stall',
                        `${label} upload error: ${unwrapTransportErrorChain(writeErr)}`,
                        writeErr
                    ));
                }
            }
        };

        // Phase 1: DNS + TCP + TLS Handshake Guard
        connectTimer = setTimeout(() => {
            recordHostHealOrClearOnPhaseFailure(true);
            failAttempt(new VpnTransportPhaseError(
                'connect_tls',
                `${label} connect/TLS handshake timed out after ${Math.round(connectTimeoutMs / 1000)}s (VPN route or IPv6 stall).`
            ));
        }, connectTimeoutMs);

        req.on('socket', (sock: any) => {
            activeSocket = sock;
            clearFreeSocketTimer(sock);
            try { sock.setNoDelay(true); } catch { /* ignore */ }
            try { sock.setKeepAlive(true, keepAliveDelayMs); } catch { /* ignore */ }

            if (isHttps) {
                const tlsSock = sock as tls.TLSSocket;
                // In Node v22+, OpenSSL pre-populates getProtocol() before TLS handshake completes
                // while tlsSock.secureConnecting is still true; require !secureConnecting too.
                const alreadySecure = !sock.connecting
                    && !(tlsSock as any).secureConnecting
                    && typeof tlsSock.getProtocol === 'function'
                    && tlsSock.getProtocol() !== null;
                if (alreadySecure) {
                    void runPacedBodyUpload();
                } else {
                    sock.once('secureConnect', () => {
                        try { sock.setNoDelay(true); } catch { /* ignore */ }
                        try { sock.setKeepAlive(true, keepAliveDelayMs); } catch { /* ignore */ }
                        void runPacedBodyUpload();
                    });
                }
            } else if (!sock.connecting) {
                void runPacedBodyUpload();
            } else {
                sock.once('connect', () => {
                    void runPacedBodyUpload();
                });
            }
        });

        req.once('response', (res: http.IncomingMessage) => {
            responseReceived = true;
            clearAllPhaseTimers();
            wakeDrainWaiter();
            if (settled) {
                try { res.destroy(); } catch { /* ignore */ }
                return;
            }
            settled = true;

            const status = res.statusCode ?? 500;
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
                if (k.toLowerCase() === 'content-encoding') continue;
                if (Array.isArray(v)) {
                    for (const item of v) headers.append(k, item);
                } else if (typeof v === 'string') {
                    headers.set(k, v);
                }
            }

            const decodedNodeStream = wrapDecompressedStream(res);
            let streamEndedCleaned = false;
            const cleanupAbortOnStreamEnd = () => {
                if (streamEndedCleaned) return;
                streamEndedCleaned = true;
                if (options.signal) {
                    options.signal.removeEventListener('abort', onAbortSignal);
                }
                if (!req.writableEnded) {
                    try { req.destroy(); } catch { /* ignore */ }
                }
            };
            let streamErrorHandled = false;
            decodedNodeStream.once('end', cleanupAbortOnStreamEnd);
            decodedNodeStream.once('close', cleanupAbortOnStreamEnd);
            decodedNodeStream.on('error', () => {
                cleanupAbortOnStreamEnd();
                if (!streamErrorHandled) {
                    streamErrorHandled = true;
                    evictIdleVpnSockets();
                    markVpnHostPreferFreshIpv4(parsedUrl.hostname);
                }
            });

            if (options.signal && !options.signal.aborted) {
                const abortActiveBody = () => {
                    const abortErr = new Error('This operation was aborted');
                    abortErr.name = 'AbortError';
                    try { decodedNodeStream.destroy(abortErr); } catch { /* ignore */ }
                    try { res.destroy(abortErr); } catch { /* ignore */ }
                    try { req.destroy(abortErr); } catch { /* ignore */ }
                };
                options.signal.removeEventListener('abort', onAbortSignal);
                options.signal.addEventListener('abort', abortActiveBody, { once: true });
                decodedNodeStream.once('close', () => {
                    options.signal?.removeEventListener('abort', abortActiveBody);
                });
            }

            const webBody = Readable.toWeb(decodedNodeStream) as unknown as ReadableStream<Uint8Array>;
            resolve(new Response(webBody, {
                status,
                statusText: res.statusMessage ?? '',
                headers,
            }));
        });
    });
}

/**
 * Executes an HTTPS/HTTP request with VPN-hardened socket lifecycle, 4-phase timeouts,
 * `16 KB` paced writes, `15s` TCP keep-alives, and automatic pre-header IPv4 self-healing,
 * while strictly honoring proxy-mode VPNs (`HTTPS_PROXY` / `http.proxy`) and OS VPN routing.
 */
export async function vpnResilientFetch(
    url: string,
    options: VpnResilientFetchOptions = {}
): Promise<Response> {
    const monkeyPatchedFetch = (!options.fetchImpl && typeof globalThis.fetch === 'function' && globalThis.fetch !== INITIAL_GLOBAL_FETCH)
        ? globalThis.fetch
        : undefined;
    const effectiveFetchImpl = options.fetchImpl ?? monkeyPatchedFetch;
    if (
        effectiveFetchImpl
        || isExplicitProxyActiveForUrl(url, {
            env: options.env,
            explicitProxySetting: options.explicitProxySetting,
            proxySupport: options.proxySupport,
        })
    ) {
        return await executeProxyOrCustomFetch(url, { ...options, fetchImpl: effectiveFetchImpl });
    }

    const parsed = new URL(url);
    const label = options.label || 'Gemini';
    const autoHeal = options.autoHealPreHeaderFailure !== false;
    const hostStickyIpv4 = shouldVpnHostPreferFreshIpv4(parsed.hostname);
    const initialFresh = Boolean(options.forceFreshSocket || hostStickyIpv4);
    const initialIpv4 = Boolean(options.preferIpv4 || hostStickyIpv4);

    const attemptStart = Date.now();
    try {
        return await executeNodeHttpAttempt(url, options, initialFresh, initialIpv4);
    } catch (firstErr: any) {
        const elapsed = Date.now() - attemptStart;
        const maxHealMs = (options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)
            + (options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS)
            + 5_000;
        // Only run immediate 0ms in-place autoHeal if Attempt 1 used pooled sockets or dual-stack DNS;
        // if Attempt 1 was ALREADY fresh+IPv4, bubble immediately to spaced outer backoff so retries don't multiply.
        if (
            autoHeal
            && !(initialFresh && initialIpv4)
            && !options.signal?.aborted
            && isPreHeaderSelfHealableError(firstErr, elapsed, maxHealMs)
        ) {
            const detail = unwrapTransportErrorChain(firstErr).slice(0, 180);
            const healNote = `${label} VPN/tunnel pre-header stall (${detail}); reconnecting immediately on fresh IPv4 socket inside tunnel`;
            options.onGuardEvent?.(healNote);
            return await executeNodeHttpAttempt(url, options, true, true);
        }
        throw firstErr;
    }
}
