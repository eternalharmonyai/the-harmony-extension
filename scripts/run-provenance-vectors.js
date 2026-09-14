#!/usr/bin/env node
/**
 * Frozen conformance vectors for the Harmony Citation & Archive Format v1.
 *
 *   node scripts/run-provenance-vectors.js            verify against frozen vectors
 *   node scripts/run-provenance-vectors.js --freeze   regenerate them (deliberate act)
 *
 * WHY FROZEN: the vectors are the regression suite, not documentation. If a refactor
 * changes canonical bytes or the text normaliser, every existing signature silently
 * breaks and nothing else in the build would notice. Freezing makes that fail loudly,
 * on the commit that causes it.
 *
 * Conformance is defined as REPRODUCING THESE VECTORS, not as implementing the prose in
 * the spec. A second implementation that passes this file interoperates; one that merely
 * reads §3 and §7 sincerely may not — the normaliser especially is too fuzzy to
 * reimplement identically from prose.
 *
 * Hermetic: no network, no clock, no filesystem beyond the vectors themselves.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VECTORS = path.join(ROOT, 'spec', 'test-vectors', 'vectors.json');
const C = require(path.join(ROOT, 'out', 'citationRecord.js'));

/**
 * Ed25519 test key. PUBLISHED AND NOT SECRET — it exists so signature vectors are
 * reproducible. Never use it for anything real.
 */
const TEST_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIAVkqNsUUAm8Tq7fhg79qAX1HJYQgbVfOeZf7g56Sfnv
-----END PRIVATE KEY-----`;
const TEST_KEY_PUBLIC_HEX = '6529fcf49e1e740bca8064db55fc4f3d8774c3a0913905e880b10583aeba45dc';

// ─── The corpus the vectors are built from ──────────────────────────────────

const CANONICAL_CASES = [
    { name: 'key ordering', input: { b: 1, a: 'x' } },
    { name: 'order independence', input: { a: 'x', b: 1 } },
    { name: 'nulls dropped', input: { a: 1, b: null, c: 'keep' } },
    { name: 'nested sorting', input: { z: { y: 2, x: 1 }, a: [3, 2, 1] } },
    { name: 'unicode string', input: { t: 'Dag Hammarskjöld — Résumé 中文' } },
    { name: 'escapes', input: { t: 'quote " backslash \\ newline \n tab \t' } },
    { name: 'empty containers', input: { arr: [], obj: {}, s: '' } },
    { name: 'negative and zero', input: { neg: -42, zero: 0, big: 9007199254740991 } },
    { name: 'booleans', input: { t: true, f: false } },
    // Astral keys sort differently by UTF-16 code unit (RFC 8785) than by code point.
    // U+1D400 precedes U+FB00 by code unit and follows it by code point.
    { name: 'astral key order (UTF-16 code unit)', input: { '\u{1D400}': 1, '\uFB00': 2 } },
    { name: 'negative zero normalises to 0', input: { z: -0 } },
    { name: 'exponent form emits decimal', input: { n: 1e2 } },
];

/** The normaliser is the likeliest source of silent cross-implementation divergence. */
const NORMALIZATION_CASES = [
    { name: 'plain passthrough', input: 'Simple text.', isHtml: false },
    { name: 'collapse spaces and tabs', input: 'a  \t  b', isHtml: false },
    { name: 'CRLF to LF', input: 'a\r\nb\r\nc', isHtml: false },
    { name: 'lone CR to LF', input: 'a\rb', isHtml: false },
    { name: 'trim ends', input: '   padded   ', isHtml: false },
    { name: 'collapse blank runs', input: 'a\n\n\n\n\nb', isHtml: false },
    { name: 'strip indent around newline', input: 'a   \n   b', isHtml: false },
    { name: 'html tags stripped', input: '<p>Hello <b>world</b></p>', isHtml: true },
    { name: 'script content removed', input: '<p>keep</p><script>drop()</script><p>keep2</p>', isHtml: true },
    { name: 'style content removed', input: '<style>.x{color:red}</style><p>keep</p>', isHtml: true },
    { name: 'entities decoded', input: '<p>a &amp; b &lt; c &quot;d&quot; &#39;e&#39;</p>', isHtml: true },
    { name: 'numeric entity', input: '<p>&#65;&#66;&#67;</p>', isHtml: true },
    { name: 'html not treated as html', input: '<p>literal</p>', isHtml: false },
    { name: 'unicode preserved', input: '<p>Hammarskjöld 中文 — em dash</p>', isHtml: true },
    { name: 'nbsp handling', input: 'a b', isHtml: false },
    { name: 'empty input', input: '', isHtml: false },
    { name: 'whitespace only', input: '   \n\t  ', isHtml: false },
    // --- Unicode ambiguity. Without these, an NFC rule change is invisible. ---
    { name: 'NFD combining acute folds to NFC', input: 'cafe\u0301', isHtml: false },
    { name: 'NFC already normalised', input: 'caf\u00e9', isHtml: false },
    { name: 'NFD inside html', input: '<p>cafe\u0301 re\u0301sume\u0301</p>', isHtml: true },
    { name: 'NFD hangul jamo', input: '\u1100\u1161\u11a8', isHtml: false },
    { name: 'astral character preserved', input: 'math \u{1D400} bold A', isHtml: false },
];

const CAPTURE_BODIES = [
    {
        url: 'https://example.org/record/5788',
        retrieved: '2026-09-05', retrieved_at: '2026-09-05T09:37:26Z',
        http_status: 200,
        content_sha256: null, // filled from the normalised text below
        normalization: 'harmony-text/1',
        evidence_tier: 'content', retrieval_class: 'harvest',
        engine: 'primary:example.org', jurisdiction: 'institutional',
        observer: { signer: 'vector', jurisdiction: 'US' },
        title: 'Example document title',
        verbatim: 'Example document operative text for the frozen vector corpus.',
    },
    {
        url: 'https://example.org/record/2233',
        retrieved: '2026-09-05', retrieved_at: '2026-09-05T09:40:00Z',
        http_status: 200,
        content_sha256: null,
        normalization: 'harmony-text/1',
        evidence_tier: 'content', retrieval_class: 'harvest',
        observer: { signer: 'vector', jurisdiction: 'US' },
        // hash-only: no verbatim
    },
    {
        url: 'https://example.org/record/9001',
        retrieved: '2026-09-05', retrieved_at: '2026-09-05T09:45:00Z',
        http_status: 200,
        raw_sha256: null,       // filled from the raw bytes below
        raw_base64: null,
        content_sha256: null,   // filled from the NORMALISED form of the same bytes
        normalization: 'harmony-text/2',
        evidence_tier: 'content', retrieval_class: 'archive',
        observer: { signer: 'vector', jurisdiction: 'US' },
        title: 'NFD archival payload',
    },
];
const HASH_ONLY_TEXT = 'Second document operative text.';
// Deliberately NFD: the byte sequence an archive must preserve exactly, and which the
// comparison layer folds to NFC. Two identities, one document.
const RAW_NFD_TEXT = 'cafe\u0301 re\u0301sume\u0301  \r\n  archival bytes';

/**
 * Fixed recovery public key for the genesis vector. Only the PUBLIC half is needed —
 * genesis/1 is signed by the PRINCIPAL, and merely commits to the recovery keyid.
 * Published, not secret, and not a usable key pair.
 */
const TEST_RECOVERY_PUBLIC_HEX =
    '11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff';

const LIVENESS_CASES = [
    { name: 'live-unchanged', status: 200, body: 'BASELINE', headers: { 'content-type': 'text/plain' }, expect: 'live-unchanged' },
    { name: 'altered', status: 200, body: 'Different text entirely.', headers: { 'content-type': 'text/plain' }, expect: 'altered' },
    { name: 'soft-404 english', status: 200, body: 'Page not found. The page you requested does not exist.', headers: { 'content-type': 'text/html' }, expect: 'soft-404' },
    { name: 'soft-404 repository phrasing', status: 200, body: 'Requested record does not seem to exist.', headers: { 'content-type': 'text/html' }, expect: 'soft-404' },
    { name: 'moved', status: 301, body: '', headers: { location: 'https://example.test/new' }, expect: 'moved' },
    { name: 'removed 404', status: 404, body: '', headers: {}, expect: 'removed' },
    { name: 'removed 410', status: 410, body: '', headers: {}, expect: 'removed' },
    { name: 'blocked 403', status: 403, body: '', headers: { 'cf-ray': 'x' }, expect: 'blocked' },
    { name: 'blocked 429', status: 429, body: '', headers: { 'retry-after': '60' }, expect: 'blocked' },
    { name: 'blocked challenge', status: 200, body: 'Just a moment... Checking your browser', headers: { 'content-type': 'text/html' }, expect: 'blocked' },
    { name: 'transient 503', status: 503, body: '', headers: {}, expect: 'transient-error' },
];

// ─── Builders ───────────────────────────────────────────────────────────────

async function loadKey() {
    const W = require(path.join(ROOT, 'out', 'webBotAuth.js'));
    const pubText = `signer: vector\nalgorithm: ed25519\npublic_key: ${TEST_KEY_PUBLIC_HEX}\n`;
    return W.loadSigningKey(TEST_KEY_PEM, pubText);
}

const resp = (status, body, headers) => ({
    status,
    headers: { get: k => headers[k.toLowerCase()] ?? null },
    text: async () => body,
});

async function build() {
    const key = await loadKey();

    const canonicalization = CANONICAL_CASES.map(c => ({
        name: c.name, input: c.input, canonical: C.canonicalize(c.input),
    }));

    const normalization = [];
    for (const c of NORMALIZATION_CASES) {
        const output = C.normalizeText(c.input, { isHtml: c.isHtml });
        normalization.push({
            name: c.name, input: c.input, isHtml: c.isHtml,
            output, sha256: await C.sha256Hex(output),
        });
    }

    const bodies = JSON.parse(JSON.stringify(CAPTURE_BODIES));
    bodies[0].content_sha256 = await C.contentHash(bodies[0].verbatim);
    bodies[1].content_sha256 = await C.contentHash(HASH_ONLY_TEXT);
    // R13: archival hash over the RAW bytes; comparison hash over the normalised form.
    // They must differ here — that difference is the whole point of separating them.
    const rawBytes = new TextEncoder().encode(RAW_NFD_TEXT);
    bodies[2].raw_sha256 = await C.sha256Hex(rawBytes);
    bodies[2].raw_base64 = Buffer.from(rawBytes).toString('base64');
    bodies[2].content_sha256 = await C.contentHash(RAW_NFD_TEXT);
    if (bodies[2].raw_sha256 === bodies[2].content_sha256) {
        throw new Error('R13 vector is degenerate: raw and normalised hashes coincide');
    }

    let chainState = C.emptyChain('vector', key.keyid);
    const records = [];
    for (const body of bodies) {
        const r = await C.createCapture(body, chainState, key);
        chainState = r.chain;
        records.push(r.record);
    }

    const baselineHash = bodies[0].content_sha256;
    const liveness = [];
    for (const c of LIVENESS_CASES) {
        const body = c.body === 'BASELINE' ? bodies[0].verbatim : c.body;
        const out = await C.checkLiveness(
            { id: records[0].id, url: 'https://example.test/doc', content_sha256: baselineHash },
            { fetchImpl: async () => resp(c.status, body, c.headers), now: () => new Date('2026-10-01T00:00:00Z') }
        );
        liveness.push({ name: c.name, status: c.status, expect: c.expect, verdict: out.verdict, suggestion: out.diagnostic.suggestion ?? null });
    }

    // A genesis-bound chain: the recommended shape. The legacy
    // chain above is retained deliberately — both paths must keep working.
    const recoveryRaw = new Uint8Array(
        TEST_RECOVERY_PUBLIC_HEX.match(/../g).map(h => parseInt(h, 16)));
    const g = await C.startChain(key, recoveryRaw, '2026-09-05T00:00:00Z');
    let boundState = g.chain;
    const boundRecords = [g.record];
    const boundCapture = await C.createCapture(bodies[0], boundState, key);
    boundState = boundCapture.chain;
    boundRecords.push(boundCapture.record);

    return {
        spec: 'harmony-citation/1',
        genesis_chain: { records: boundRecords, recovery_public_key_hex: TEST_RECOVERY_PUBLIC_HEX },
        note: 'FROZEN. Regenerate only with --freeze, and only when a format change is intended.',
        test_key: { warning: 'PUBLISHED TEST KEY — NOT SECRET, NEVER USE FOR ANYTHING REAL', public_key_hex: TEST_KEY_PUBLIC_HEX, keyid: key.keyid },
        canonicalization, normalization,
        chain: { records },
        liveness,
    };
}

// ─── Verify ─────────────────────────────────────────────────────────────────

function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

async function verify(frozen) {
    const fails = [];
    const pass = [];
    const key = await loadKey();

    if (frozen.test_key.keyid !== key.keyid) {
        fails.push(`test key thumbprint drifted: ${frozen.test_key.keyid} -> ${key.keyid}`);
    } else pass.push('test key thumbprint');

    for (const v of frozen.canonicalization) {
        const got = C.canonicalize(v.input);
        if (got !== v.canonical) fails.push(`canonicalization/${v.name}: expected ${v.canonical} got ${got}`);
        else pass.push(`canonicalization/${v.name}`);
    }

    for (const v of frozen.normalization) {
        const got = C.normalizeText(v.input, { isHtml: v.isHtml });
        if (got !== v.output) {
            fails.push(`normalization/${v.name}: expected ${JSON.stringify(v.output)} got ${JSON.stringify(got)}`);
        } else if (await C.sha256Hex(got) !== v.sha256) {
            fails.push(`normalization/${v.name}: hash drifted`);
        } else pass.push(`normalization/${v.name}`);
    }

    // Rebuild the chain from the frozen bodies; ids and signatures must match byte for byte.
    let chainState = C.emptyChain('vector', key.keyid);
    for (const expected of frozen.chain.records) {
        const r = await C.createCapture(expected.body, chainState, key);
        chainState = r.chain;
        if (r.record.id !== expected.id) {
            fails.push(`chain/seq${expected.seq}: id drifted ${expected.id} -> ${r.record.id}`);
        } else if (r.record.signature.sig !== expected.signature.sig) {
            fails.push(`chain/seq${expected.seq}: signature drifted`);
        } else if (!deepEqual(r.record.prev, expected.prev)) {
            fails.push(`chain/seq${expected.seq}: prev drifted`);
        } else pass.push(`chain/seq${expected.seq}`);
    }

    const raw = new Uint8Array((TEST_KEY_PUBLIC_HEX.match(/../g)).map(h => parseInt(h, 16)));
    const v = await C.verifyChain(frozen.chain.records, raw);
    if (!v.ok) fails.push(`chain verification failed: ${JSON.stringify(v.issues)}`);
    else pass.push('frozen chain verifies');

    // Genesis-bound chain: reproduce it, and confirm the binding is reported in-chain.
    if (frozen.genesis_chain) {
        const recoveryRaw = new Uint8Array(
            frozen.genesis_chain.recovery_public_key_hex.match(/../g).map(h => parseInt(h, 16)));
        const g = await C.startChain(key, recoveryRaw, frozen.genesis_chain.records[0].body.created_at);
        if (g.record.id !== frozen.genesis_chain.records[0].id) {
            fails.push('genesis/seq1: id drifted');
        } else pass.push('genesis/seq1');
        const cap = await C.createCapture(frozen.genesis_chain.records[1].body, g.chain, key);
        if (cap.record.id !== frozen.genesis_chain.records[1].id) {
            fails.push('genesis/seq2: id drifted');
        } else pass.push('genesis/seq2');
        const gv = await C.verifyChainWithRevocation(frozen.genesis_chain.records, raw, {
            recoveryPublicKeyRaw: recoveryRaw,
        });
        if (gv.revocation.binding !== 'in-chain') {
            fails.push(`genesis binding: expected in-chain, got ${gv.revocation.binding}`);
        } else pass.push('genesis binding reported in-chain');
        if (gv.issues.length) fails.push(`genesis chain issues: ${JSON.stringify(gv.issues)}`);
        else pass.push('genesis chain verifies clean');
    }

    const baseline = frozen.chain.records[0].body.content_sha256;
    for (const lv of frozen.liveness) {
        const c = LIVENESS_CASES.find(x => x.name === lv.name);
        if (!c) { fails.push(`liveness/${lv.name}: case missing from source corpus`); continue; }
        const body = c.body === 'BASELINE' ? frozen.chain.records[0].body.verbatim : c.body;
        const out = await C.checkLiveness(
            { id: 'x', url: 'https://example.test/doc', content_sha256: baseline },
            { fetchImpl: async () => resp(c.status, body, c.headers), now: () => new Date('2026-10-01T00:00:00Z') }
        );
        if (out.verdict !== lv.verdict) fails.push(`liveness/${lv.name}: expected ${lv.verdict} got ${out.verdict}`);
        else if (out.verdict !== lv.expect) fails.push(`liveness/${lv.name}: verdict ${out.verdict} != intent ${lv.expect}`);
        else pass.push(`liveness/${lv.name}`);
    }

    return { pass, fails };
}

// ─── Main ───────────────────────────────────────────────────────────────────

(async () => {
    const freeze = process.argv.includes('--freeze');
    if (freeze) {
        const built = await build();
        fs.mkdirSync(path.dirname(VECTORS), { recursive: true });
        fs.writeFileSync(VECTORS, JSON.stringify(built, null, 2) + '\n', 'utf8');
        console.log(`Froze ${built.canonicalization.length} canonicalization, ` +
            `${built.normalization.length} normalization, ${built.chain.records.length} chain, ` +
            `${built.liveness.length} liveness vectors -> ${path.relative(ROOT, VECTORS)}`);
        console.log('Review the diff before committing: a change here is a FORMAT change.');
        return;
    }

    if (!fs.existsSync(VECTORS)) {
        console.error(`No frozen vectors at ${path.relative(ROOT, VECTORS)}. Run with --freeze first.`);
        process.exit(1);
    }
    const frozen = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
    const { pass, fails } = await verify(frozen);
    for (const f of fails) console.log(`FAIL  ${f}`);
    console.log(`\n${pass.length} vector(s) reproduced, ${fails.length} drifted.`);
    if (fails.length) {
        console.log('\nA drifted vector means the FORMAT changed. If that was intentional, bump the');
        console.log('spec version and re-freeze. If not, this is the regression you were looking for.');
        process.exit(1);
    }
    console.log('Conformance: OK');
})().catch(e => { console.error('VECTOR RUNNER ERROR:', e); process.exit(1); });
