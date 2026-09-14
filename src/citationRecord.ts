/**
 * Reference implementation of the Harmony Citation & Archive Format v1.
 * Specification: spec/harmony-citation-format-v1.md — the spec is normative, this is not.
 *
 * Creates, signs, chains, and verifies capture and liveness records, and performs the
 * n-state liveness re-check. Signing reuses the agent's signing keys through
 * webBotAuth.loadSigningKey, so an agent's fetch identity and its citation identity are
 * the same Ed25519 key: a verifier that already trusts the agent's requests knows how to
 * resolve its citations.
 *
 * Host-agnostic: WebCrypto only, no npm packages, no `vscode`. The only runtime import is
 * webBotAuth (itself import-free).
 */

import type { webcrypto } from 'node:crypto';
import { base64UrlEncode, jwkThumbprint, type SigningKey } from './webBotAuth';

type Bin = ArrayBuffer | ArrayBufferView;

export const SPEC_VERSION = 'harmony-citation/1';
export const NORMALIZATION = 'harmony-text/2';

// ─── Types ──────────────────────────────────────────────────────────────────

export type EvidenceTier = 'snippet' | 'content';
export type RetrievalClass = 'index' | 'synthesis' | 'harvest' | 'archive';

/**
 * Seven states. The last two describe THE NETWORK PATH, not the document — see spec §7.
 * Never aggregate `blocked` or `transient-error` as `removed`: a 403 from a WAF and a 410
 * from a publisher are opposite claims.
 */
export type LivenessVerdict =
    | 'live-unchanged'
    | 'altered'
    | 'soft-404'
    | 'moved'
    | 'removed'
    | 'blocked'
    | 'transient-error';

/** True when the verdict says something about the document rather than the connection. */
export function isDocumentVerdict(v: LivenessVerdict): boolean {
    return v !== 'blocked' && v !== 'transient-error';
}

export interface Observer {
    signer: string;
    jurisdiction?: string;
}

export interface CaptureBody {
    /**
     * The URL EXACTLY AS FETCHED. Never re-serialised: `new URL(u).toString()`
     * lowercases the host, resolves dot segments, drops default ports and percent-encodes
     * non-ASCII, so round-tripping would change the signed bytes and break lookups.
     */
    url: string;
    retrieved: string;      // YYYY-MM-DD — never rewritten
    retrieved_at: string;   // canonical instant, see TIMESTAMP_RE
    http_status: number;
    /**
     * ARCHIVAL identity: sha256 of the RAW bytes as received. Byte-exact and
     * normalisation-independent, so it survives Unicode version drift — which is why
     * an archive must not key on normalised text.
     */
    raw_sha256?: string;
    /** Raw bytes, base64. Omit for a hash-only record; the archival hash still stands. */
    raw_base64?: string;
    /**
     * COMPARISON identity: sha256 of the normalised text. This is what liveness compares,
     * so that whitespace and encoding churn do not report `altered` on an untouched page.
     */
    content_sha256: string;
    normalization: string;
    evidence_tier: EvidenceTier;
    retrieval_class: RetrievalClass;
    engine?: string;
    jurisdiction?: string;
    observer: Observer;
    title?: string;
    headers?: Record<string, string>;
    /**
     * Derived NORMALISED text, hashing to content_sha256. Optional by design: omit for a
     * hash-only record that proves without redistributing. This is a comparison artifact,
     * not the archive — `raw_base64` is the archive.
     */
    verbatim?: string;
}

export interface FetchDiagnostic {
    retry_count: number;
    headers?: Record<string, string>;
    error_code?: string;
    message?: string;
    /** Fixed vocabulary, never model-generated prose. */
    suggestion?: string;
}

export interface LivenessBody {
    capture: string;
    url: string;
    checked_at: string;
    verdict: LivenessVerdict;
    http_status?: number;
    baseline_sha256: string;
    content_sha256?: string;
    final_url?: string;
    diagnostic: FetchDiagnostic;
}

export interface SignedRecord<B = unknown> {
    harmony_record: string;
    seq: number;
    prev: string | null;
    body: B;
    id: string;
    signature: { alg: 'ed25519'; keyid: string; signer: string; sig: string };
}

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

// ─── Canonical form (spec §3) ───────────────────────────────────────────────

/**
 * Canonical bytes, per spec §3. Follows RFC 8785 (JCS) where it applies:
 *
 *  - Object keys sort by UTF-16 CODE UNIT, which is what JCS specifies and what
 *    Array.prototype.sort() does. (The spec previously said "code point"; those orders
 *    diverge for astral characters — U+1D400 sorts before U+FB00 by code unit and after
 *    it by code point. The implementation was right and the prose was wrong.)
 *  - Strings MUST already be Unicode NFC. Canonicalisation REJECTS non-NFC rather than
 *    silently normalising, because normalising here would change the very bytes the hash
 *    is meant to attest.
 *  - Integers only, emitted in plain decimal: no exponent, no leading zeros, no -0.
 *  - null members omitted entirely.
 */
export function canonicalize(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
        if (!Number.isInteger(value)) {
            throw new Error(`non-integer number in record: ${value} (spec §3 forbids floats)`);
        }
        if (!Number.isSafeInteger(value)) {
            throw new Error(`integer ${value} exceeds the safe range; implementations would disagree`);
        }
        // Object.is distinguishes -0 from 0, which String() does not.
        return Object.is(value, -0) ? '0' : String(value);
    }
    if (typeof value === 'string') {
        if (value.normalize('NFC') !== value) {
            throw new Error(
                'string is not Unicode NFC; canonicalisation refuses to normalise silently ' +
                'because that would alter the bytes being attested (spec §3)'
            );
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj)
            .filter(k => obj[k] !== undefined && obj[k] !== null)
            .sort(); // UTF-16 code-unit order, matching RFC 8785 §3.2.3.
        return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
    }
    throw new Error(`unserialisable value of type ${typeof value}`);
}

function utf8(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

function hex(bytes: Uint8Array): string {
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Canonical instant: UTC, `Z`, whole seconds. "RFC 3339" alone permits
 * `+00:00`, fractional seconds and non-UTC offsets, so two producers can write the same
 * moment three ways and sign three different records.
 */
export const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function isCanonicalTimestamp(value: unknown): value is string {
    return typeof value === 'string' && TIMESTAMP_RE.test(value)
        && !Number.isNaN(Date.parse(value));
}

/** Format an instant in the canonical grammar. */
export function toCanonicalTimestamp(d: Date): string {
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
    const data = typeof input === 'string' ? utf8(input) : input;
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data as Bin)));
}

/**
 * Signing domain . The SAME Ed25519 key signs Web Bot Auth requests and
 * citation records — that one-key design was deliberate, which is exactly why the two
 * contexts must be cryptographically separated rather than merely structurally different.
 * Web Bot Auth is already separated by RFC 9421's `tag="web-bot-auth"`; this is the
 * citation side of the same discipline.
 *
 * NUL cannot appear in JSON text, so the separator is unambiguous.
 */
export const SIGNING_DOMAIN = 'harmony-citation/1';

/**
 * The exact bytes that are hashed and signed: a domain tag, the record type, then the
 * envelope minus `id` and `signature`.
 */
export function signingBytes(harmony_record: string, seq: number, prev: string | null, body: unknown): string {
    return `${SIGNING_DOMAIN}\0${harmony_record}\0` +
        canonicalize({ harmony_record, seq, prev, body });
}

// ─── Text normalisation (spec §7) ───────────────────────────────────────────

/**
 * `harmony-text/1`. Hashing raw bytes makes every session id, CSRF token and rotating
 * widget report `altered` on a document nobody touched; a week of false positives buries
 * the true signal. Deliberately conservative — it collapses whitespace and strips markup,
 * and does NOT attempt boilerplate removal, which would vary by site and break agreement
 * between implementations.
 */
export function normalizeText(input: string, opts: { isHtml?: boolean } = {}): string {
    let s = input;
    if (opts.isHtml) {
        s = s
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ');
    }
    return s
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/\s*\n\s*/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        // NFC last: "café" as NFC and as NFD are the same document and MUST hash alike.
        // Added in harmony-text/2 — this is why the normaliser carries a version.
        .normalize('NFC');
}

export async function contentHash(text: string, opts: { isHtml?: boolean } = {}): Promise<string> {
    return sha256Hex(normalizeText(text, opts));
}

// ─── Chain construction ─────────────────────────────────────────────────────

export interface ChainHead {
    spec: string;
    signer: string;
    keyid: string;
    head: string | null;
    count: number;
}

export function emptyChain(signer: string, keyid: string): ChainHead {
    return { spec: SPEC_VERSION, signer, keyid, head: null, count: 0 };
}

async function signRecord<B>(
    type: string, body: B, chain: ChainHead, key: SigningKey
): Promise<{ record: SignedRecord<B>; chain: ChainHead }> {
    const seq = chain.count + 1;
    const prev = chain.head;
    const bytes = signingBytes(type, seq, prev, body);
    const id = await sha256Hex(bytes);
    const sigBuf = await crypto.subtle.sign(
        { name: 'Ed25519' }, key.privateKey as webcrypto.CryptoKey, utf8(bytes) as Bin
    );
    let bin = '';
    for (const b of new Uint8Array(sigBuf)) bin += String.fromCharCode(b);

    return {
        record: {
            harmony_record: type, seq, prev, body, id,
            signature: { alg: 'ed25519', keyid: key.keyid, signer: key.signer, sig: btoa(bin) },
        },
        chain: { ...chain, head: id, count: seq },
    };
}

export function createCapture(body: CaptureBody, chain: ChainHead, key: SigningKey) {
    if (body.retrieval_class === 'synthesis' && body.evidence_tier === 'content') {
        throw new Error(
            'synthesis output can never be evidence_tier "content" (spec §6): it is prose ' +
            'about sources, not text from a source'
        );
    }
    return signRecord('capture/1', body, chain, key);
}

export function createLiveness(body: LivenessBody, chain: ChainHead, key: SigningKey) {
    return signRecord('liveness/1', body, chain, key);
}

// ─── Verification (spec §9) ─────────────────────────────────────────────────

export interface VerifyIssue { seq: number; id: string; problem: string }

/**
 * Verify a whole chain. Returns every problem found rather than throwing on the first —
 * a partially valid chain still needs its valid prefix identified.
 */
export async function verifyChain(
    records: SignedRecord[], publicKeyRaw: Uint8Array
): Promise<{ ok: boolean; issues: VerifyIssue[]; verified: number }> {
    const issues: VerifyIssue[] = [];
    const expectedKeyid = await jwkThumbprint(publicKeyRaw);
    let prev: string | null = null;
    let verified = 0;

    const pub = await crypto.subtle.importKey(
        'raw', publicKeyRaw as Bin, { name: 'Ed25519' }, false, ['verify']
    );

    const ordered = [...records].sort((a, b) => a.seq - b.seq);
    for (const rec of ordered) {
        const at = (problem: string) => issues.push({ seq: rec.seq, id: rec.id, problem });

        if (rec.signature.keyid !== expectedKeyid) { at('keyid does not match the supplied public key'); continue; }
        if (rec.seq !== (prev === null ? 1 : verified + 1)) at(`seq ${rec.seq} is out of order`);
        if (rec.prev !== prev) at(`prev does not link to the previous record (expected ${prev ?? 'null'})`);
        if (rec.seq === 1 && rec.prev !== null) at('genesis record must have prev: null');

        let bytes: string;
        try {
            bytes = signingBytes(rec.harmony_record, rec.seq, rec.prev, rec.body);
        } catch (e) {
            at(`canonicalisation failed: ${(e as Error).message}`); prev = rec.id; continue;
        }

        const id = await sha256Hex(bytes);
        if (id !== rec.id) at('id does not match the canonical bytes (record was modified)');

        // Untrusted input: never let a malformed signature throw out of verification.
        try {
            const raw = atob(rec.signature.sig);
            const sigBytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) sigBytes[i] = raw.charCodeAt(i);
            const ok = await crypto.subtle.verify(
                { name: 'Ed25519' }, pub, sigBytes as Bin, utf8(bytes) as Bin
            );
            if (!ok) at('signature does not verify over the canonical bytes');
        } catch (e) {
            at(`signature could not be decoded or verified: ${(e as Error).message}`);
        }

        if (rec.harmony_record === 'capture/1') {
            const b = rec.body as CaptureBody;
            if (b.retrieval_class === 'synthesis' && b.evidence_tier === 'content') {
                at('retrieval_class "synthesis" with evidence_tier "content" (spec §6)');
            }
            // An unparseable retrieval date is a REJECTION, never a skipped check — the
            // failure mode that silently disabled freshness validation elsewhere.
            if (!/^\d{4}-\d{2}-\d{2}$/.test(b.retrieved ?? '')) {
                at(`retrieved "${b.retrieved}" is not YYYY-MM-DD`);
            }
            if (b.verbatim !== undefined) {
                const h = await contentHash(b.verbatim);
                if (h !== b.content_sha256) at('verbatim does not hash to content_sha256');
            }
        }

        prev = rec.id;
        verified++;
    }
    return { ok: issues.length === 0, issues, verified };
}

// ─── Liveness re-check (spec §7) ────────────────────────────────────────────

/**
 * English-language soft-404 signatures. Necessarily incomplete and necessarily
 * English-biased — a real limitation, not an oversight. `calibrateSoftError` below is the
 * language-independent detector; these are the zero-extra-request fallback.
 * The "does not seem to exist" phrasing is observed live on a repository's soft-404 page.
 */
const SOFT_404_SIGNATURES = [
    /\bpage not found\b/i, /\b404\b[\s\S]{0,40}\bnot found\b/i,
    /\bthe page you (are looking for|requested)\b/i, /\bthis page (has moved|no longer exists)\b/i,
    /requested [\w\s]{0,24}(does not|doesn't)\s+(seem to\s+)?exist/i,
    /\b(record|document|resource)\s+not found\b/i,
];

/** Token set for similarity, with digits dropped so record ids don't distinguish pages. */
function tokenSet(text: string): Set<string> {
    return new Set(
        text.toLowerCase().replace(/\d+/g, '').split(/[^a-z]+/).filter(t => t.length > 2)
    );
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let shared = 0;
    for (const t of a) if (b.has(t)) shared++;
    return shared / (a.size + b.size - shared);
}

/**
 * Language-independent soft-404 detection: fetch a sibling URL that certainly does not
 * exist and compare. If the target renders essentially the same page as a known-missing
 * one, it is an error page regardless of what language it apologises in.
 *
 * Costs one extra request, so it is opt-in and only runs after a hash mismatch — the only
 * point where the answer changes anything.
 */
async function looksLikeKnownErrorPage(
    url: string, targetText: string,
    doFetch: (u: string, i?: RequestInit) => Promise<Response>,
    userAgent: string, timeoutMs: number
): Promise<boolean> {
    try {
        const u = new URL(url);
        const segments = u.pathname.split('/').filter(Boolean);
        if (segments.length === 0) return false;
        segments[segments.length - 1] = 'harmony-liveness-probe-0000000000';
        u.pathname = '/' + segments.join('/');

        const res = await doFetch(u.toString(), {
            redirect: 'manual',
            headers: { 'User-Agent': userAgent },
            signal: AbortSignal.timeout(timeoutMs),
        });
        // A correct 404 here means the site does NOT serve soft-404s, so the target's
        // mismatch is a genuine edit.
        if (res.status !== 200) return false;
        const probeText = normalizeText(await res.text(), { isHtml: true });
        return jaccard(tokenSet(probeText), tokenSet(targetText)) > 0.9;
    } catch {
        return false; // probe failure must never manufacture a verdict
    }
}

const CHALLENGE_SIGNATURES = [
    /just a moment/i, /cf-browser-verification/i, /checking your browser/i,
    /enable javascript and cookies to continue/i, /attention required/i,
];

export interface LivenessCheckOptions {
    timeoutMs?: number;
    userAgent?: string;
    /** Inject a signed fetch (Web Bot Auth) or a stub for testing. */
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    now?: () => Date;
    /**
     * Spend one extra request to disambiguate soft-404 from a genuine edit, without
     * relying on English error wording. Only runs when the hash already mismatched.
     */
    calibrateSoftError?: boolean;
}

/**
 * Re-check a captured URL and produce a liveness verdict. Never throws: a network failure
 * is a verdict (`transient-error`), not an exception — the whole point is that absence and
 * unreachability get recorded rather than lost.
 */
export async function checkLiveness(
    capture: { id: string; url: string; content_sha256: string },
    opts: LivenessCheckOptions = {}
): Promise<LivenessBody> {
    const doFetch = opts.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
    const checked_at = (opts.now?.() ?? new Date()).toISOString();
    const base: Omit<LivenessBody, 'verdict' | 'diagnostic'> = {
        capture: capture.id, url: capture.url, checked_at,
        baseline_sha256: capture.content_sha256,
    };
    const diag = (d: Partial<FetchDiagnostic> = {}): FetchDiagnostic => ({ retry_count: 0, ...d });

    let res: Response;
    try {
        res = await doFetch(capture.url, {
            redirect: 'manual',
            headers: { 'User-Agent': opts.userAgent ?? 'Harmony-Search/0.1' },
            signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
        });
    } catch (e) {
        const msg = (e as Error).message ?? String(e);
        return {
            ...base, verdict: 'transient-error',
            diagnostic: diag({ error_code: (e as { name?: string }).name, message: msg, suggestion: 'retry-later' }),
        };
    }

    const status = res.status;
    const headers: Record<string, string> = {};
    for (const h of ['etag', 'last-modified', 'retry-after', 'cf-ray', 'content-type']) {
        const v = res.headers.get(h);
        if (v) headers[h] = v;
    }

    if (status >= 300 && status < 400) {
        const loc = res.headers.get('location');
        const final = loc ? new URL(loc, capture.url).toString() : undefined;
        // A redirect back to the same URL is not a move.
        if (final && final !== capture.url) {
            return { ...base, verdict: 'moved', http_status: status, final_url: final,
                     diagnostic: diag({ headers, suggestion: 'update-citation-url' }) };
        }
    }

    if (status === 404 || status === 410) {
        return { ...base, verdict: 'removed', http_status: status,
                 diagnostic: diag({ headers, suggestion: 'check-archive' }) };
    }

    if (status === 401 || status === 403 || status === 429) {
        // Says nothing about the document — only that this network cannot see it.
        return { ...base, verdict: 'blocked', http_status: status,
                 diagnostic: diag({ headers, suggestion: 'unverifiable-from-this-network' }) };
    }

    if (status >= 500) {
        return { ...base, verdict: 'transient-error', http_status: status,
                 diagnostic: diag({ headers, suggestion: 'retry-later' }) };
    }

    let text: string;
    try {
        text = await res.text();
    } catch (e) {
        return { ...base, verdict: 'transient-error', http_status: status,
                 diagnostic: diag({ headers, message: (e as Error).message, suggestion: 'retry-later' }) };
    }

    if (CHALLENGE_SIGNATURES.some(re => re.test(text))) {
        return { ...base, verdict: 'blocked', http_status: status,
                 diagnostic: diag({ headers, suggestion: 'unverifiable-from-this-network' }) };
    }

    const isHtml = (headers['content-type'] ?? '').includes('html');
    const now_sha = await contentHash(text, { isHtml });

    if (now_sha === capture.content_sha256) {
        return { ...base, verdict: 'live-unchanged', http_status: status, content_sha256: now_sha,
                 diagnostic: diag({ headers }) };
    }

    // soft-404 needs POSITIVE identification, never a bare hash mismatch — otherwise
    // "removed" creeps back in through the side door on every edited page.
    const normalized = normalizeText(text, { isHtml });
    let soft = SOFT_404_SIGNATURES.some(re => re.test(normalized.slice(0, 4000)));
    if (!soft && opts.calibrateSoftError) {
        soft = await looksLikeKnownErrorPage(
            capture.url, normalized, doFetch,
            opts.userAgent ?? 'Harmony-Search/0.1', opts.timeoutMs ?? 20_000
        );
    }
    if (soft) {
        return { ...base, verdict: 'soft-404', http_status: status, content_sha256: now_sha,
                 diagnostic: diag({ headers, suggestion: 'check-archive' }) };
    }

    return { ...base, verdict: 'altered', http_status: status, content_sha256: now_sha,
             diagnostic: diag({ headers, suggestion: 'content-changed' }) };
}

// ─── Storage layout (spec §8) ───────────────────────────────────────────────

/** `citations/<signer>/records/<seq padded>-<id prefix>.json` */
export function recordPath(signer: string, rec: SignedRecord): string {
    return `citations/${signer}/records/${String(rec.seq).padStart(6, '0')}-${rec.id.slice(0, 12)}.json`;
}

export function serializeRecord(rec: SignedRecord): string {
    return JSON.stringify(rec, null, 2) + '\n';
}

/** Base64url of the raw public key, for embedding a JWK next to a chain. */
export function publicKeyJwkX(publicKeyRaw: Uint8Array): string {
    return base64UrlEncode(publicKeyRaw);
}

// ─── Genesis binding (spec §11) ─────────────────────────────────

/**
 * `genesis/1` — the first record of a chain, binding the principal to its recovery key
 * IN SIGNED, HASH-CHAINED MATERIAL.
 *
 * Without this, the recovery binding lived only in `<signer>.pub` — a mutable plain file
 * distributed by git. That covered key compromise but not REPOSITORY compromise, which is
 * the likelier event: an attacker with repo write access could rewrite
 * `recovery_public_key:` to a key they hold and issue a valid-looking revocation, or swap
 * it so a legitimate revocation failed to verify. The binding's integrity was assumed,
 * never established.
 *
 * Placed at seq 1 and signed by the principal at generation time, the binding is now
 * covered by the chain hash: editing the .pub afterwards is detectable by comparison, and
 * editing the genesis record breaks every signature after it.
 *
 * A chain without a genesis record is still valid — but it is `sidecar-only` bound, and
 * verification says so rather than implying the weaker mode is the strong one.
 */
export interface GenesisBody {
    signer: string;
    /** The principal's own keyid. Self-declared, and checked against the verifying key. */
    keyid: string;
    /** THE BINDING: thumbprint of the key permitted to revoke this principal. */
    recovery_keyid: string;
    created_at: string;
}

export async function createGenesis(
    body: GenesisBody, key: SigningKey
): Promise<{ record: SignedRecord<GenesisBody>; chain: ChainHead }> {
    if (body.keyid !== key.keyid) {
        throw new Error('genesis.keyid must be the signing key\'s own thumbprint');
    }
    if (body.recovery_keyid === key.keyid) {
        throw new Error('recovery_keyid must differ from the principal keyid (spec §11 rule 1)');
    }
    return signRecord('genesis/1', body, emptyChain(key.signer, key.keyid), key);
}

/** Open a chain with its recovery binding committed in-chain. The recommended start. */
export async function startChain(
    key: SigningKey, recoveryPublicKeyRaw: Uint8Array, createdAt: string
): Promise<{ record: SignedRecord<GenesisBody>; chain: ChainHead }> {
    return createGenesis({
        signer: key.signer,
        keyid: key.keyid,
        recovery_keyid: await jwkThumbprint(recoveryPublicKeyRaw),
        created_at: createdAt,
    }, key);
}

/** The genesis record of a chain, if it has one. */
export function findGenesis(records: SignedRecord[]): SignedRecord<GenesisBody> | undefined {
    return records.find(r => r.harmony_record === 'genesis/1' && r.seq === 1) as
        SignedRecord<GenesisBody> | undefined;
}

// ─── Revocation (spec §11) ──────────────────────────────────────────────────

/**
 * `revocation/1` — retire a compromised or rotated key in-band.
 *
 * Three properties, each answering a way revocation usually fails:
 *
 * 1. NOT SELF-SIGNED. Signed by a RECOVERY key generated alongside the principal and
 *    bound in the principal's published `.pub` at generation time. Self-signed revocation
 *    is worthless: an attacker holding the key can revoke, or decline to. Because the
 *    binding predates any compromise, an attacker cannot nominate their own recovery key.
 *
 * 2. SUSPECT, NOT INVALID. `valid_through` names the last record known good. Earlier
 *    records stay verified; later ones become `suspect`. Destroying good history to
 *    punish a later breach loses exactly the provenance the format exists to keep.
 *
 * 3. ABSENCE OF A REVOCATION IS NOT EVIDENCE OF NON-REVOCATION. Records travel as files,
 *    so a verifier who has not pulled recently may simply not have seen one. Verification
 *    reports `data_as_of` and says so, rather than implying a key is good. Same epistemics
 *    as `blocked` never meaning `removed`.
 */
export type RevocationReason = 'compromise' | 'rotation' | 'retirement' | 'precaution';

export interface RevocationBody {
    /** JWK thumbprint of the principal key being revoked. */
    revokes_keyid: string;
    signer: string;
    revoked_at: string;
    /**
     * `id` of the last record known good. Records after it are `suspect`.
     * `null` means the compromise date is unknown — the whole chain is suspect.
     */
    valid_through: string | null;
    reason: RevocationReason;
    /**
     * Instant from which the key may already have been in hostile hands .
     * `valid_through` is a position claim ("this record was the last I vouch for");
     * this is a time claim ("everything from here is unsafe"), and a revoker often knows
     * the second more confidently than the first. Records claiming a time at or after this
     * lose `verified` even if they precede valid_through in sequence.
     *
     * Self-WIDENING, so it is the trustworthy kind of claim: it can only enlarge the
     * revoker's own doubt, never shrink it.
     */
    compromised_since?: string;
    note?: string;
    /**
     * Optional m-of-n quorum attestation, for when the recovery key is also lost.
     * Each attester signs the revocation's canonical bytes with its own principal key.
     */
    attestations?: { signer: string; keyid: string; sig: string }[];
}

/** Read the `recovery_public_key:` binding out of a published `.pub` file. */
export function recoveryKeyFromPub(pubText: string): Uint8Array | undefined {
    const hex = /^recovery_public_key:\s*([0-9a-fA-F]{64})$/m.exec(pubText)?.[1];
    if (!hex) return undefined;
    return new Uint8Array((hex.match(/../g) ?? []).map(h => parseInt(h, 16)));
}

/**
 * Create a revocation. Standalone (seq 1, prev null) rather than an entry in the
 * principal's chain — a different key signs it, and a chain is keyed to one signer.
 */
export async function createRevocation(
    body: RevocationBody, recoveryKey: SigningKey
): Promise<SignedRecord<RevocationBody>> {
    if (recoveryKey.keyid === body.revokes_keyid) {
        throw new Error(
            'a revocation must not be signed by the key it revokes: use the recovery key ' +
            'bound in the principal\'s .pub (spec §11)'
        );
    }
    const bytes = signingBytes('revocation/1', 1, null, body);
    const id = await sha256Hex(bytes);
    const sigBuf = await crypto.subtle.sign(
        { name: 'Ed25519' }, recoveryKey.privateKey as webcrypto.CryptoKey, utf8(bytes) as Bin
    );
    let bin = '';
    for (const b of new Uint8Array(sigBuf)) bin += String.fromCharCode(b);
    return {
        harmony_record: 'revocation/1', seq: 1, prev: null, body, id,
        signature: { alg: 'ed25519', keyid: recoveryKey.keyid, signer: recoveryKey.signer, sig: btoa(bin) },
    };
}

/**
 * Verify a revocation against the recovery key the principal published. Never throws —
 * a malformed revocation must not be able to crash a verifier, and must not be able to
 * silently succeed either.
 */
export async function verifyRevocation(
    rec: SignedRecord<RevocationBody>, recoveryPublicKeyRaw: Uint8Array
): Promise<{ ok: boolean; reason?: string }> {
    if (rec.harmony_record !== 'revocation/1') return { ok: false, reason: 'not a revocation/1 record' };
    const expected = await jwkThumbprint(recoveryPublicKeyRaw);
    if (rec.signature.keyid !== expected) {
        return { ok: false, reason: 'not signed by the recovery key bound in the principal\'s .pub' };
    }
    if (rec.signature.keyid === rec.body.revokes_keyid) {
        return { ok: false, reason: 'self-signed revocation (the revoked key signed it)' };
    }
    let bytes: string;
    try {
        bytes = signingBytes('revocation/1', rec.seq, rec.prev, rec.body);
    } catch (e) {
        return { ok: false, reason: `canonicalisation failed: ${(e as Error).message}` };
    }
    if (await sha256Hex(bytes) !== rec.id) return { ok: false, reason: 'id does not match canonical bytes' };
    try {
        const pub = await crypto.subtle.importKey(
            'raw', recoveryPublicKeyRaw as Bin, { name: 'Ed25519' }, false, ['verify']
        );
        const raw = atob(rec.signature.sig);
        const sig = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) sig[i] = raw.charCodeAt(i);
        const ok = await crypto.subtle.verify({ name: 'Ed25519' }, pub, sig as Bin, utf8(bytes) as Bin);
        return ok ? { ok: true } : { ok: false, reason: 'signature does not verify' };
    } catch (e) {
        return { ok: false, reason: `signature could not be decoded or verified: ${(e as Error).message}` };
    }
}

/**
 * Three states, not two .
 *
 * The reviewer argued everything after a revocation should be `invalid`, not `suspect`.
 * That is right in spirit but unimplementable as stated, because record timestamps are
 * self-asserted (§5) — an attacker simply backdates. So the split uses the only time
 * claim that can be trusted: a SELF-INCRIMINATING one.
 *
 *   verified  at or before valid_through
 *   suspect   after valid_through, claiming a time before revoked_at — an unfalsifiable
 *             self-serving claim, so it is neither trusted nor destroyed
 *   invalid   claiming a time at or after revoked_at — no legitimate holder signs with a
 *             publicly revoked key, and the record says so itself
 *
 * You can believe a claim that damns the claimant; you cannot believe one that saves them.
 */
export type RecordStatus = 'verified' | 'suspect' | 'invalid';

export type RecoveryBinding = 'in-chain' | 'sidecar-only' | 'none';

export interface RevocationStatus {
    revoked: boolean;
    /**
     * Where the recovery key was bound. `in-chain` is genesis/1 and survives repository
     * compromise; `sidecar-only` trusts a mutable .pub file and does not.
     */
    binding?: RecoveryBinding;
    valid_through?: string | null;
    revoked_at?: string;
    reason?: RevocationReason;
    /**
     * When the verifier last refreshed revocation data, or null if it never did.
     * Decision 3: a verifier MUST surface this rather than implying a key is good.
     */
    data_as_of: string | null;
    note: string;
}

export interface ChainVerificationWithRevocation {
    ok: boolean;
    issues: VerifyIssue[];
    verified: number;
    statuses: { seq: number; id: string; status: RecordStatus }[];
    revocation: RevocationStatus;
}

/**
 * Verify a chain and classify each record against any revocation.
 *
 * A revoked key does NOT make the chain invalid — it splits it at `valid_through`.
 * Signature validity and trustworthiness are different questions, and conflating them
 * would throw away history that is still perfectly well attested.
 */
export async function verifyChainWithRevocation(
    records: SignedRecord[],
    publicKeyRaw: Uint8Array,
    opts: {
        revocation?: SignedRecord<RevocationBody>;
        recoveryPublicKeyRaw?: Uint8Array;
        /** When revocation data was last refreshed (RFC 3339). */
        revocationDataAsOf?: string | null;
    } = {}
): Promise<ChainVerificationWithRevocation> {
    const base = await verifyChain(records, publicKeyRaw);
    const ordered = [...records].sort((a, b) => a.seq - b.seq);
    const asOf = opts.revocationDataAsOf ?? null;

    let revocation: RevocationStatus = {
        revoked: false,
        data_as_of: asOf,
        note: asOf
            ? `No revocation seen in data refreshed at ${asOf}. Absence of a revocation is ` +
              'not evidence of non-revocation.'
            : 'No revocation data has been refreshed. This verifier cannot distinguish ' +
              '"not revoked" from "revocation not yet seen".',
    };
    const issues = [...base.issues];

    // Resolve the AUTHORITATIVE recovery binding. genesis/1 wins over the .pub sidecar,
    // because only the former is covered by the chain hash.
    const genesis = findGenesis(ordered);
    const principalKeyidEarly = await jwkThumbprint(publicKeyRaw);
    let binding: RecoveryBinding = 'none';
    let boundRecoveryKeyid: string | undefined;

    if (genesis) {
        binding = 'in-chain';
        boundRecoveryKeyid = genesis.body.recovery_keyid;
        if (genesis.body.keyid !== principalKeyidEarly) {
            issues.push({ seq: genesis.seq, id: genesis.id, problem: 'genesis.keyid does not match the verifying public key' });
        }
        if (opts.recoveryPublicKeyRaw) {
            const sidecar = await jwkThumbprint(opts.recoveryPublicKeyRaw);
            if (sidecar !== boundRecoveryKeyid) {
                // Either the .pub was rewritten or the genesis was — the exact attack R2 named.
                issues.push({
                    seq: genesis.seq, id: genesis.id,
                    problem: 'recovery key in .pub does not match the in-chain genesis binding; ' +
                             'one of them has been altered',
                });
            }
        }
    } else if (opts.recoveryPublicKeyRaw) {
        binding = 'sidecar-only';
        boundRecoveryKeyid = await jwkThumbprint(opts.recoveryPublicKeyRaw);
    }
    revocation.binding = binding;

    if (opts.revocation) {
        if (!opts.recoveryPublicKeyRaw) {
            issues.push({ seq: 0, id: opts.revocation.id, problem: 'revocation supplied but no recovery public key to check it against' });
        } else if (boundRecoveryKeyid && opts.revocation.signature.keyid !== boundRecoveryKeyid) {
            issues.push({
                seq: 0, id: opts.revocation.id,
                problem: `revocation is signed by ${opts.revocation.signature.keyid.slice(0, 12)}… ` +
                         'which is not the recovery key bound to this chain',
            });
        } else {
            const v = await verifyRevocation(opts.revocation, opts.recoveryPublicKeyRaw);
            if (!v.ok) {
                issues.push({ seq: 0, id: opts.revocation.id, problem: `invalid revocation ignored: ${v.reason}` });
            } else {
                const principalKeyid = await jwkThumbprint(publicKeyRaw);
                if (opts.revocation.body.revokes_keyid !== principalKeyid) {
                    issues.push({ seq: 0, id: opts.revocation.id, problem: 'revocation names a different key than this chain' });
                } else {
                    const b = opts.revocation.body;
                    revocation = {
                        revoked: true,
                        binding,
                        valid_through: b.valid_through,
                        revoked_at: b.revoked_at,
                        reason: b.reason,
                        data_as_of: asOf,
                        note: b.valid_through === null
                            ? 'Key revoked with an unknown compromise point: every record is suspect.'
                            : `Key revoked. Records through ${b.valid_through.slice(0, 12)}… remain ` +
                              'verified; later records are suspect, not invalid.',
                    };
                }
            }
        }
    }

    // Split the chain at valid_through, then again at revoked_at (see RecordStatus).
    const revokedAt = revocation.revoked ? opts.revocation?.body.revoked_at : undefined;
    const claimedTime = (rec: SignedRecord): string | undefined => {
        const b = rec.body as { retrieved_at?: string; checked_at?: string; created_at?: string };
        return b.retrieved_at ?? b.checked_at ?? b.created_at;
    };
    const compromisedSince = revocation.revoked ? opts.revocation?.body.compromised_since : undefined;
    let past = false;
    const statuses = ordered.map(rec => {
        let status: RecordStatus = 'verified';
        if (revocation.revoked) {
            const t = claimedTime(rec);
            // R11: the compromise window can open BEFORE valid_through. A record inside it
            // is not verified regardless of its position in the sequence.
            const inWindow = !!(compromisedSince && t && t >= compromisedSince);
            const afterCut = revocation.valid_through === null ? true : past;
            if (afterCut || inWindow) {
                // Self-incriminating: the record itself claims to postdate the revocation.
                status = (revokedAt && t && t >= revokedAt) ? 'invalid' : 'suspect';
            }
            if (revocation.valid_through !== null && rec.id === revocation.valid_through) past = true;
        }
        return { seq: rec.seq, id: rec.id, status };
    });

    return { ok: issues.length === 0, issues, verified: base.verified, statuses, revocation };
}
