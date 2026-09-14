/**
 * Web Bot Auth — cryptographically verifiable agent identity for Harmony's fetch path.
 *
 * Implements the Cloudflare/IETF Web Bot Auth profile of HTTP Message Signatures
 * (RFC 9421): an Ed25519 signature over a small, fixed component set, carried in
 * `Signature-Agent`, `Signature-Input` and `Signature` headers, with public keys
 * published as a JWKS directory that verifiers fetch by URL.
 *
 * WHY THIS EXISTS
 * A novel User-Agent makes a crawler MORE likely to be challenged, not less: anti-bot
 * systems distrust unknown agents by default. The honest remedy is not to look like
 * something else — it is to prove who you are. Signing converts "an unrecognised UA"
 * into "a verified agent", and it is the only approach that survives the project's own
 * rule against UA rotation, proxy pools, and fingerprint mimicry.
 *
 * KEY REUSE
 * Reuses existing local signing keys verbatim — no new key ceremony:
 *   private key   PKCS8 PEM, unencrypted
 *   public key    text, `public_key: <64 hex chars>`
 * Both are covered by .gitignore (`*.key`, `keys/`).
 *
 * HOST-AGNOSTIC
 * WebCrypto only — no npm packages, no `vscode`, and no runtime imports at all: the single
 * `import type` below is erased at compile time, so the emitted JS imports nothing. Runs
 * unchanged in the extension host, the Tauri UI, the CLI, and a bridge node. Ed25519 in
 * WebCrypto requires Node >= 18.4 or a current browser.
 *
 * SCOPE / LIMITS
 * - Covers `@authority` and `signature-agent`, the Web Bot Auth baseline. Request bodies
 *   are NOT covered; this attests identity, not payload integrity.
 * - A signature proves which key signed, i.e. origin under a role. It does not prove
 *   which human or model composed the request.
 * - Verification here is self-verification (round-trip). Acceptance by any given verifier
 *   additionally requires publishing the directory and, for some, registry enrolment.
 */

// Type-only import: erased at compile time, contributes nothing to the emitted JS.
import type { webcrypto } from 'node:crypto';

/** WebCrypto binary input. Named locally because the project builds without the DOM lib. */
type Bin = ArrayBuffer | ArrayBufferView;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SigningKey {
    /** Agent name, read from the key file. */
    signer: string;
    /** Imported Ed25519 private key. */
    privateKey: webcrypto.CryptoKey;
    /** Raw 32-byte Ed25519 public key. */
    publicKeyRaw: Uint8Array;
    /** RFC 7638 JWK thumbprint (base64url, unpadded) — the `keyid`. */
    keyid: string;
}

export interface SignerConfig {
    /** Absolute URL of the published JWKS directory. Sent as `Signature-Agent`. */
    directoryUrl: string;
    /** Seconds the signature stays valid. Web Bot Auth expects a short window. */
    ttlSeconds?: number;
    /** Override the clock (testing). Seconds since epoch. */
    now?: () => number;
}

export interface SignedHeaders {
    'Signature-Agent': string;
    'Signature-Input': string;
    'Signature': string;
}

export interface AgentCardInput {
    /** Human-readable agent name, e.g. 'Harmony Source Harvest'. */
    name: string;
    /**
     * The ACCOUNTABLE ENTITY behind the crawler — the organisation a site owner would
     * hold responsible. This field is a PUBLISHED CLAIM, not a label, so:
     *   - use the entity form of the name ('Eternal Harmony LLC'), never a one-token
     *     handle or username form;
     *   - only name an entity that actually operates the crawler. A test fixture must use
     *     a synthetic entity (e.g. 'Example Operator LLC'), because a real company name
     *     there asserts accountability that nobody intended, and downstream copies of the
     *     fixture would carry it further.
     */
    operator: string;
    contactUrl: string;
    /** Declared politeness budget. Verifiers may hold you to it; keep it true. */
    expectedRequestsPerMinute: number;
    description?: string;
}

const DEFAULT_TTL_SECONDS = 300;
const SIG_LABEL = 'sig1';
const COVERED = ['@authority', 'signature-agent'] as const;
const TAG = 'web-bot-auth';
const ALG = 'ed25519';

// ─── Encoding helpers ───────────────────────────────────────────────────────

export function base64UrlEncode(bytes: Uint8Array): string {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64Encode(bytes: Uint8Array): string {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

function base64Decode(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function hexToBytes(hex: string): Uint8Array {
    const clean = hex.trim().toLowerCase();
    if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) {
        throw new Error('public_key is not valid hex');
    }
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/** Strip PEM armour to raw DER. */
function pemToDer(pem: string): Uint8Array {
    const body = pem
        .replace(/-----BEGIN [^-]+-----/g, '')
        .replace(/-----END [^-]+-----/g, '')
        .replace(/\s+/g, '');
    if (!body) throw new Error('no PEM body found');
    return base64Decode(body);
}

/** Quote a structured-field String (RFC 8941 §3.3.3). */
function sfString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ─── Key loading ────────────────────────────────────────────────────────────

/**
 * RFC 7638 JWK thumbprint for an Ed25519 (OKP) key. Members must appear in
 * lexicographic order with no whitespace — the hash is over the exact bytes.
 */
export async function jwkThumbprint(publicKeyRaw: Uint8Array): Promise<string> {
    const x = base64UrlEncode(publicKeyRaw);
    const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${x}"}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Load a signing key pair from raw PEM/public-key text.
 *
 * @param privatePem PKCS8 PEM private key contents
 * @param publicPub  public-key file contents (`public_key: <hex>`)
 */
export async function loadSigningKey(privatePem: string, publicPub: string): Promise<SigningKey> {
    const signer = (/^signer:\s*(.+)$/m.exec(publicPub)?.[1] ?? 'unknown').trim();
    const algo = (/^algorithm:\s*(.+)$/m.exec(publicPub)?.[1] ?? '').trim();
    if (algo && algo.toLowerCase() !== 'ed25519') {
        throw new Error(`unsupported key algorithm '${algo}' (Web Bot Auth requires ed25519)`);
    }
    const hex = /^public_key:\s*([0-9a-fA-F]+)$/m.exec(publicPub)?.[1];
    if (!hex) throw new Error('no `public_key:` line found in .pub file');
    const publicKeyRaw = hexToBytes(hex);
    if (publicKeyRaw.length !== 32) {
        throw new Error(`ed25519 public key must be 32 bytes, got ${publicKeyRaw.length}`);
    }

    let privateKey: webcrypto.CryptoKey;
    try {
        privateKey = await crypto.subtle.importKey(
            'pkcs8', pemToDer(privatePem) as Bin, { name: 'Ed25519' }, false, ['sign']
        );
    } catch (e) {
        throw new Error(
            `could not import private key as Ed25519 PKCS8: ${(e as Error).message}. ` +
            `Ed25519 in WebCrypto needs Node >= 18.4 or a current browser.`
        );
    }

    // Confirm the private key actually matches the published public key. A mismatched pair
    // would otherwise sign silently, producing signatures that verify nowhere. A key-loading
    // error is cheap; an unverifiable signature discovered later is not.
    const probe = new TextEncoder().encode('harmony-keypair-consistency-probe') as Bin;
    try {
        const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, probe);
        const pub = await crypto.subtle.importKey(
            'raw', publicKeyRaw as Bin, { name: 'Ed25519' }, false, ['verify']
        );
        if (!(await crypto.subtle.verify({ name: 'Ed25519' }, pub, sig, probe))) {
            throw new Error('mismatch');
        }
    } catch {
        throw new Error(
            `private key does not match the published public_key for signer "${signer}" ` +
            '- signer/key mismatch. Signatures made with this pair would verify nowhere.'
        );
    }

    return { signer, privateKey, publicKeyRaw, keyid: await jwkThumbprint(publicKeyRaw) };
}

// ─── Signature base (RFC 9421 §2.5) ─────────────────────────────────────────

/**
 * Build the exact bytes that get signed. Every verifier reconstructs this
 * independently, so a single stray byte fails the signature — it is written out
 * explicitly rather than assembled cleverly.
 */
export function buildSignatureBase(params: {
    authority: string;
    directoryUrl: string;
    created: number;
    expires: number;
    keyid: string;
}): { base: string; signatureInput: string } {
    const covered = COVERED.map(c => `"${c}"`).join(' ');
    const sigParams =
        `(${covered});created=${params.created};expires=${params.expires}` +
        `;keyid=${sfString(params.keyid)};alg=${sfString(ALG)};tag=${sfString(TAG)}`;

    const lines = [
        `"@authority": ${params.authority}`,
        `"signature-agent": ${sfString(params.directoryUrl)}`,
        `"@signature-params": ${sigParams}`, // final line carries no trailing newline
    ];
    return { base: lines.join('\n'), signatureInput: `${SIG_LABEL}=${sigParams}` };
}

/** Authority per RFC 9421: lowercase host, with port only when non-default. */
export function authorityOf(url: string): string {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const isDefault = (u.protocol === 'https:' && (u.port === '' || u.port === '443'))
        || (u.protocol === 'http:' && (u.port === '' || u.port === '80'));
    return isDefault ? host : `${host}:${u.port}`;
}

// ─── Signing ────────────────────────────────────────────────────────────────

export async function signRequest(
    url: string, key: SigningKey, config: SignerConfig
): Promise<SignedHeaders> {
    const now = Math.floor((config.now?.() ?? Date.now() / 1000));
    const created = now;
    const expires = now + (config.ttlSeconds ?? DEFAULT_TTL_SECONDS);

    const { base, signatureInput } = buildSignatureBase({
        authority: authorityOf(url),
        directoryUrl: config.directoryUrl,
        created,
        expires,
        keyid: key.keyid,
    });

    const sig = await crypto.subtle.sign(
        { name: 'Ed25519' }, key.privateKey, new TextEncoder().encode(base) as Bin
    );

    return {
        'Signature-Agent': sfString(config.directoryUrl),
        'Signature-Input': signatureInput,
        'Signature': `${SIG_LABEL}=:${base64Encode(new Uint8Array(sig))}:`,
    };
}

/**
 * Verify a signature we (or a peer) produced. Used for round-trip self-test and for
 * verifying peer requests in the peer mesh. Returns a reason on failure rather than
 * a bare false — a silent auth failure is the worst kind to debug.
 */
export async function verifySignature(
    url: string, headers: SignedHeaders, publicKeyRaw: Uint8Array,
    opts: { now?: () => number } = {}
): Promise<{ ok: boolean; reason?: string }> {
    const input = headers['Signature-Input'];
    const created = Number(/;created=(\d+)/.exec(input)?.[1]);
    const expires = Number(/;expires=(\d+)/.exec(input)?.[1]);
    const keyid = /;keyid="([^"]+)"/.exec(input)?.[1];
    if (!created || !expires || !keyid) return { ok: false, reason: 'malformed Signature-Input' };

    const now = Math.floor(opts.now?.() ?? Date.now() / 1000);
    if (now > expires) return { ok: false, reason: `signature expired at ${expires} (now ${now})` };
    if (created > now + 60) return { ok: false, reason: 'created is in the future' };

    const expectedKeyid = await jwkThumbprint(publicKeyRaw);
    if (keyid !== expectedKeyid) return { ok: false, reason: 'keyid does not match the public key' };

    const dir = /^"(.*)"$/.exec(headers['Signature-Agent'])?.[1]?.replace(/\\"/g, '"');
    if (!dir) return { ok: false, reason: 'malformed Signature-Agent' };

    const { base } = buildSignatureBase({
        authority: authorityOf(url), directoryUrl: dir, created, expires, keyid,
    });

    const raw = /:(.+):/.exec(headers['Signature'])?.[1];
    if (!raw) return { ok: false, reason: 'malformed Signature' };

    // Every value below is attacker-controlled. Verification must never throw:
    // an exception escaping into the fetch path is a denial-of-service, and a
    // crash is a strictly worse failure mode than a rejection with a reason.
    try {
        const pub = await crypto.subtle.importKey(
            'raw', publicKeyRaw as Bin, { name: 'Ed25519' }, false, ['verify']
        );
        const ok = await crypto.subtle.verify(
            { name: 'Ed25519' }, pub, base64Decode(raw) as Bin,
            new TextEncoder().encode(base) as Bin
        );
        return ok ? { ok: true } : { ok: false, reason: 'signature did not verify over the signature base' };
    } catch (e) {
        return { ok: false, reason: `signature could not be decoded or verified: ${(e as Error).message}` };
    }
}

// ─── Published directory + agent card ───────────────────────────────────────

/**
 * JWKS served at the `Signature-Agent` URL, conventionally
 * `/.well-known/http-message-signatures-directory`. Verifiers fetch this to resolve
 * `keyid` to a public key. Contains public keys ONLY.
 */
export async function buildKeyDirectory(keys: SigningKey[]): Promise<string> {
    const jwks = await Promise.all(keys.map(async k => ({
        kty: 'OKP',
        crv: 'Ed25519',
        x: base64UrlEncode(k.publicKeyRaw),
        kid: k.keyid,
        use: 'sig',
        alg: 'Ed25519',
        nbf: undefined as number | undefined,
    })));
    return JSON.stringify({ keys: jwks.map(({ nbf, ...rest }) => rest) }, null, 2);
}

/**
 * Signature Agent Card — the registry metadata describing who this agent is and how
 * it behaves. `expectedRequestsPerMinute` is a promise to operators; keep the crawler's
 * real rate limiter below it, or the card becomes the thing that proves you misbehaved.
 */
export async function buildAgentCard(input: AgentCardInput, keys: SigningKey[]): Promise<string> {
    return JSON.stringify({
        name: input.name,
        description: input.description,
        operator: input.operator,
        contact: input.contactUrl,
        expected_request_rate: { requests: input.expectedRequestsPerMinute, per: 'minute' },
        signature_algorithm: 'ed25519',
        keys: keys.map(k => ({ kid: k.keyid, signer: k.signer, x: base64UrlEncode(k.publicKeyRaw) })),
    }, null, 2);
}

// ─── Drop-in fetch wrapper ──────────────────────────────────────────────────

/**
 * `fetch` with Web Bot Auth headers attached. Signature covers `@authority`, so it must
 * be recomputed per redirect hop — `redirect: 'manual'` keeps that honest rather than
 * letting the platform silently replay a signature at a different authority.
 */
export function createSignedFetch(
    key: SigningKey, config: SignerConfig, opts: { maxRedirects?: number } = {}
) {
    const maxRedirects = opts.maxRedirects ?? 5;

    return async function signedFetch(url: string, init: RequestInit = {}): Promise<Response> {
        let current = url;

        for (let hop = 0; ; hop++) {
            const headers = new Headers(init.headers ?? {});
            const signed = await signRequest(current, key, config);
            for (const [k, v] of Object.entries(signed)) headers.set(k, v);

            // Redirects are followed by hand because the signature covers @authority.
            // Letting the platform follow them would replay a signature minted for one
            // host at another — it would fail verification there at best, and at worst
            // hand our signed identity to a host we never signed for.
            const res = await fetch(current, { ...init, headers, redirect: 'manual' });

            const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
            if (!location) return res;
            if (hop >= maxRedirects) {
                throw new Error(`too many redirects (${maxRedirects}) starting at ${url}`);
            }
            current = new URL(location, current).toString(); // re-signed for the new authority
        }
    };
}
