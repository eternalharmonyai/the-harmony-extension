/**
 * Shared transport-resilience primitives.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two independent retry implementations had grown in this repo:
 *
 *   - `deepSwarm.callWithRetry` — 3 attempts, exponential backoff, and a
 *     circuit breaker. Genuinely enterprise-grade, but reachable only from the
 *     swarm pipeline.
 *   - the chat agent loop — a single turn-wide `networkRetried` boolean and a
 *     fixed 2s pause. The swarm's better behaviour never reached the surface
 *     the user actually lives in.
 *
 * The chat loop is where the damage is worst, because a chat turn is a
 * *sequence* of provider calls (16+ steps is routine). A boolean scoped to the
 * whole turn means one reset at step 17 spends the budget that 16 completed
 * steps never used. That is not "one retry" — it is one retry for the entire
 * turn, whatever the turn cost.
 *
 * So the primitives live here, once, and both callers share them. This module
 * deliberately makes NO decisions about how many attempts a caller gets or what
 * it does on exhaustion; it only answers three questions:
 *
 *   1. Is this error worth retrying, and what kind is it?  -> classifyTransient
 *   2. How long should I wait before attempt N?            -> backoffDelayMs
 *   3. Has this provider earned a pause?                   -> circuit breaker
 *
 * HONEST LIMIT: none of this makes a remote TCP reset stop happening. The
 * provider edge will still drop sockets. What it buys is that a drop becomes
 * survivable rather than fatal, and that the wait before the next attempt is
 * long enough to land on a different edge rather than the one that is shedding.
 */

export type TransientKind = 'server-5xx' | 'rate-limit' | 'transport' | 'none';

export interface TransientVerdict {
    /** True when a retry is worth attempting. */
    transient: boolean;
    kind: TransientKind;
    /** Server-requested delay, in ms, when the error exposed one. */
    retryAfterMs?: number;
    /** Short human-readable reason, for the visible retry notice. */
    reason: string;
}

/** Provider-supplied retry hint. Accepts `Retry-After: 3` and `retry after 3000ms`. */
const RETRY_AFTER_SECONDS = /\bretry[-_ ]?after["']?\s*[:=]\s*(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds)?/i;
const RETRY_AFTER_MS = /\bretry[-_ ]?after["']?\s*[:=]\s*(\d+(?:\.\d+)?)\s*ms\b/i;

const SERVER_5XX = /\bhttp 5\d{2}\b|"internal_error"|"server_error"|\boverloaded\b|\bunavailable\b/i;
const RATE_LIMIT = /\b429\b|\brate[-_ ]?limit\b|\btoo many requests\b/i;
const TRANSPORT = /\bterminated\b|\beconnreset\b|\betimedout\b|\betimeout\b|\bepipe\b|\benetunreach\b|\behostunreach\b|\beaddrnotavail\b|\beconnrefused\b|\beai_again\b|\bsocket hang ?up\b|\bother side closed\b|\bpremature close\b|\bund_err\b|\bfetch failed\b|\bnetwork ?error\b|\btls error\b|\babort(?:ed)?\b|timed out before the first response bytes|stream idle timeout|connect\/tls handshake timed out|request upload stalled/i;

function flattenErrorWithCauses(error: unknown): string {
    const parts: string[] = [];
    let cur: any = error;
    let depth = 0;
    while (cur && depth < 5) {
        const name = typeof cur?.name === 'string' ? cur.name : '';
        const phase = typeof cur?.phase === 'string' ? `[${cur.phase}]` : '';
        const code = typeof cur?.code === 'string' ? cur.code : '';
        const msg = typeof cur?.message === 'string' ? cur.message : (depth === 0 ? String(cur ?? '') : '');
        const chunk = [name, phase, code, msg].filter(Boolean).join(' ');
        if (chunk && !parts.includes(chunk)) {
            parts.push(chunk);
        }
        cur = cur?.cause;
        depth += 1;
    }
    return parts.join(' <- ');
}

/**
 * Specific human-readable transport phase label for visible retry notices & ledgers,
 * distinguishing VPN tunnel connect/upload stalls from post-upload TTFB or stream drops.
 */
export function describeTransientPhase(error: unknown): string {
    const text = flattenErrorWithCauses(error);
    if (/\[connect_tls\]|connect\/tls handshake timed out/i.test(text)) {
        return 'connect/TLS stalled on tunnel';
    }
    if (/\[upload_stall\]|request upload stalled/i.test(text)) {
        return 'request upload stalled (VPN/MTU blackhole)';
    }
    if (/\[ttfb_timeout\]|timed out before the first response bytes/i.test(text)) {
        return 'first-byte response timeout';
    }
    if (/stream idle timeout/i.test(text)) {
        return 'mid-stream idle timeout';
    }
    if (/\benetunreach\b|\behostunreach\b|\beaddrnotavail\b|\beai_again\b/i.test(text)) {
        return 'VPN/network route rebinding';
    }
    return 'connection interrupted';
}

/** Reads a provider-retry hint out of the error text, when one is present. */
function parseRetryAfter(text: string): number | undefined {
    const ms = text.match(RETRY_AFTER_MS);
    if (ms) {
        const n = Number(ms[1]);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    const secs = text.match(RETRY_AFTER_SECONDS);
    if (secs) {
        const n = Number(secs[1]);
        if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000);
    }
    return undefined;
}

/**
 * Decide whether an error is worth another attempt, and why.
 *
 * Order matters: rate-limit and 5xx are checked before the generic transport
 * patterns, because a provider can return "overloaded" *and* drop the socket,
 * and the retry hint that matters is the rate-limit one.
 */
export function classifyTransient(error: unknown): TransientVerdict {
    const text = flattenErrorWithCauses(error);
    const retryAfterMs = parseRetryAfter(text);

    if (RATE_LIMIT.test(text)) {
        return { transient: true, kind: 'rate-limit', retryAfterMs, reason: 'rate limited' };
    }
    if (SERVER_5XX.test(text)) {
        return { transient: true, kind: 'server-5xx', retryAfterMs, reason: 'transient server error' };
    }
    if (TRANSPORT.test(text)) {
        return { transient: true, kind: 'transport', retryAfterMs, reason: 'connection interrupted' };
    }
    return { transient: false, kind: 'none', retryAfterMs, reason: 'not transient' };
}

export interface BackoffOptions {
    /** Delay before attempt 2. Default 2000ms, matching the historical first pause. */
    baseMs?: number;
    /** Absolute ceiling regardless of attempt number. Default 15000ms. */
    capMs?: number;
    /** Provider-supplied hint, honoured as a floor so we never retry sooner than asked. */
    retryAfterMs?: number;
    /** Injectable randomness, for deterministic tests. Default Math.random. */
    random?: () => number;
}

/**
 * Delay before the given attempt, using **equal jitter**.
 *
 * Full jitter (`random(0, cap)`) is the usual textbook answer, but it can hand
 * back near-zero — which recreates exactly the bug this file exists to fix: a
 * second attempt fired into the same edge that just shed the first. Equal
 * jitter keeps a guaranteed floor of half the computed delay while still
 * spreading concurrent retries apart:
 *
 *     half = ceiling / 2      (ceiling = min(cap, base * 2^(attempt-1)))
 *     delay = half + random(0, half)
 *
 * Attempt 1 is the *first* retry (initial call is never delayed).
 */
export function backoffDelayMs(attempt: number, options?: BackoffOptions): number {
    const baseMs = options?.baseMs ?? 2000;
    const capMs = options?.capMs ?? 15000;
    const random = options?.random ?? Math.random;
    const safeAttempt = Math.max(1, Math.floor(attempt));
    const ceiling = Math.min(capMs, baseMs * Math.pow(2, safeAttempt - 1));
    const half = ceiling / 2;
    const jittered = Math.round(half + random() * half);
    const hinted = options?.retryAfterMs;
    // Never retry sooner than the provider asked. Capped so a hostile hint
    // cannot stall a turn indefinitely.
    if (typeof hinted === 'number' && hinted > 0) {
        return Math.min(Math.max(jittered, hinted), capMs);
    }
    return jittered;
}

/** Human-readable wait, for the visible retry notice. */
export function formatWaitMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = ms / 1000;
    return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/** Cancellable sleep. Resolves early (rather than rejecting) on cancellation. */
export function delay(ms: number, token?: { isCancellationRequested: boolean; onCancellationRequested?: (fn: () => void) => { dispose(): void } }): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
        let disposable: { dispose(): void } | undefined;
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            disposable?.dispose();
            resolve();
        };
        const timer = setTimeout(finish, ms);
        if (token?.onCancellationRequested) {
            disposable = token.onCancellationRequested(finish);
        }
        if (token?.isCancellationRequested) finish();
    });
}

// ── Circuit breaker ────────────────────────────────────────────────────────

interface CircuitState {
    consecutiveFailures: number;
    /** Wall-clock time until which this provider is considered cold. */
    openUntil: number;
    lastError?: string;
}

const BREAKER_THRESHOLD = 5;
/** How long a tripped breaker stays cold before a single probe is allowed. */
const BREAKER_COOLDOWN_MS = 30_000;

const breakerStates = new Map<string, CircuitState>();

function stateFor(provider: string): CircuitState {
    let state = breakerStates.get(provider);
    if (!state) {
        state = { consecutiveFailures: 0, openUntil: 0 };
        breakerStates.set(provider, state);
    }
    return state;
}

/**
 * True when this provider has failed enough times in a row to earn a pause.
 *
 * The breaker is *advisory and self-healing*: once the cooldown expires it
 * reports open again so a single probe can go out. A breaker that latches
 * permanently is worse than no breaker, because the provider may well have
 * recovered and the user has no way to tell.
 */
export function isCircuitOpen(provider: string, now: number = Date.now()): boolean {
    const state = stateFor(provider);
    if (state.consecutiveFailures < BREAKER_THRESHOLD) return false;
    return now < state.openUntil;
}

/** Record a success, which resets the streak and closes the breaker. */
export function recordSuccess(provider: string): void {
    const state = stateFor(provider);
    state.consecutiveFailures = 0;
    state.openUntil = 0;
    state.lastError = undefined;
}

/** Record a failure. Trips the breaker once the streak reaches the threshold. */
export function recordFailure(provider: string, error?: unknown, now: number = Date.now()): void {
    const state = stateFor(provider);
    state.consecutiveFailures += 1;
    state.lastError = (error as any)?.message ?? String(error ?? '');
    if (state.consecutiveFailures >= BREAKER_THRESHOLD) {
        state.openUntil = now + BREAKER_COOLDOWN_MS;
    }
}

/** Snapshot for a user-visible health line. Never throws, never mutates. */
export function circuitStatus(provider: string, now: number = Date.now()): string {
    const state = stateFor(provider);
    if (state.consecutiveFailures === 0) return 'healthy';
    if (isCircuitOpen(provider, now)) {
        const seconds = Math.max(1, Math.ceil((state.openUntil - now) / 1000));
        return `paused ${seconds}s after ${state.consecutiveFailures} consecutive failures`;
    }
    return `${state.consecutiveFailures}/${BREAKER_THRESHOLD} consecutive failures`;
}

/** Test-only: clears every breaker. Not exported from the extension surface. */
export function resetCircuitBreakers(): void {
    breakerStates.clear();
}

export const CIRCUIT_BREAKER_THRESHOLD = BREAKER_THRESHOLD;
export const CIRCUIT_BREAKER_COOLDOWN_MS = BREAKER_COOLDOWN_MS;
