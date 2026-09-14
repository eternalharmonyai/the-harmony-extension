#!/usr/bin/env node
/**
 * Provenance suite: citation
 * HERMETIC — no network. Safe to gate merges.
 *
 * Promoted from a scratch harness so the verification evidence lives with the code it
 * verifies, and can be re-run by anyone. Requires a build first: npm run compile
 */
const HARMONY_ROOT = require('path').resolve(__dirname, '..');
const { removeSignerKeys, generateSignerKeys, signerKeyPaths } = require(HARMONY_ROOT + '/scripts/lib/keys.js');
// Validator for the Harmony Citation Format v1 reference implementation.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const C = require(HARMONY_ROOT + '/out/citationRecord.js');
const W = require(HARMONY_ROOT + '/out/webBotAuth.js');

const SIGNER = 'archivist';
const [privP, , pubP] = signerKeyPaths(SIGNER);

let fails = 0;
const check = (n, c, x) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); if (!c) fails++; };

// Minimal Response stub so all seven liveness states are reachable offline.
const resp = (status, body = '', headers = {}) => ({
    status,
    headers: { get: k => headers[k.toLowerCase()] ?? null },
    text: async () => body,
});

(async () => {
    await generateSignerKeys(SIGNER);
    const key = await W.loadSigningKey(fs.readFileSync(privP, 'utf8'), fs.readFileSync(pubP, 'utf8'));

    console.log('=== 1. Canonical form (spec §3) ===');
    check('keys sorted, no whitespace',
        C.canonicalize({ b: 1, a: 'x' }) === '{"a":"x","b":1}', C.canonicalize({ b: 1, a: 'x' }));
    check('null members dropped', C.canonicalize({ a: 1, b: null }) === '{"a":1}');
    check('key order does not change bytes',
        C.canonicalize({ a: 1, b: 2 }) === C.canonicalize({ b: 2, a: 1 }));
    let threw = false;
    try { C.canonicalize({ x: 1.5 }); } catch { threw = true; }
    check('floats rejected', threw);

    console.log('\n=== 2. Build a signed chain ===');
    let chain = C.emptyChain(SIGNER, key.keyid);
    const text = 'Example document operative text for the citation suite.';
    const hash = await C.contentHash(text);
    const capBody = {
        url: 'https://example.org/record/5788',
        retrieved: '2026-09-05', retrieved_at: '2026-09-05T09:37:26Z',
        http_status: 200, content_sha256: hash, normalization: C.NORMALIZATION,
        evidence_tier: 'content', retrieval_class: 'harvest',
        engine: 'primary:example.org', jurisdiction: 'institutional',
        observer: { signer: SIGNER, jurisdiction: 'US' }, verbatim: text,
    };
    let r1 = await C.createCapture(capBody, chain, key); chain = r1.chain;
    // Hash-only record: proves the text without redistributing it.
    const { verbatim, ...hashOnly } = capBody;
    let r2 = await C.createCapture({ ...hashOnly, url: 'https://example.org/record/2233' }, chain, key);
    chain = r2.chain;
    const records = [r1.record, r2.record];
    console.log(`  seq1 id=${r1.record.id.slice(0, 16)}…  seq2 prev=${r2.record.prev.slice(0, 16)}…`);
    check('chain links seq2.prev -> seq1.id', r2.record.prev === r1.record.id);
    check('head advanced', chain.head === r2.record.id && chain.count === 2);
    check('hash-only record omits verbatim', r2.record.body.verbatim === undefined);

    console.log('\n=== 3. Verify the chain (spec §9) ===');
    let v = await C.verifyChain(records, key.publicKeyRaw);
    check('valid chain verifies', v.ok && v.verified === 2, JSON.stringify(v.issues));

    console.log('\n=== 4. Tamper detection ===');
    const t1 = JSON.parse(JSON.stringify(records));
    t1[0].body.verbatim = 'Example document altered text …';
    let tv = await C.verifyChain(t1, key.publicKeyRaw);
    check('edited verbatim detected', !tv.ok, '-> ' + tv.issues.map(i => i.problem).join(' | '));

    const t2 = JSON.parse(JSON.stringify(records));
    t2[1].prev = t2[0].prev;
    tv = await C.verifyChain(t2, key.publicKeyRaw);
    check('broken chain link detected', !tv.ok, '-> ' + tv.issues[0].problem);

    const t3 = JSON.parse(JSON.stringify(records));
    t3[0].signature.sig = 'not!valid!base64';
    tv = await C.verifyChain(t3, key.publicKeyRaw);
    check('malformed signature rejected without throwing', !tv.ok, '-> ' + tv.issues[0].problem);

    const t4 = JSON.parse(JSON.stringify(records));
    t4[0].body.retrieved = '2026-09-05T09:37:26Z';
    tv = await C.verifyChain(t4, key.publicKeyRaw);
    check('timestamp-shaped retrieved REJECTED (not silently skipped)',
        tv.issues.some(i => /not YYYY-MM-DD/.test(i.problem)));

    const t5 = JSON.parse(JSON.stringify(records));
    tv = await C.verifyChain(t5, crypto.getRandomValues(new Uint8Array(32)));
    check('wrong public key rejected', !tv.ok, '-> ' + tv.issues[0].problem);

    console.log('\n=== 5. synthesis can never be content (spec §6) ===');
    let blocked = false;
    try {
        await C.createCapture({ ...capBody, retrieval_class: 'synthesis' }, chain, key);
    } catch (e) { blocked = true; console.log('  ' + e.message.split(':')[0]); }
    check('creation refuses synthesis+content', blocked);
    const t6 = JSON.parse(JSON.stringify(records));
    t6[0].body.retrieval_class = 'synthesis';
    tv = await C.verifyChain(t6, key.publicKeyRaw);
    check('validator also catches it', tv.issues.some(i => /synthesis/.test(i.problem)));

    console.log('\n=== 6. All seven liveness verdicts (spec §7) ===');
    const cap = { id: r1.record.id, url: 'https://example.test/doc', content_sha256: hash };
    const cases = [
        ['live-unchanged', () => resp(200, text, { 'content-type': 'text/plain' })],
        ['altered', () => resp(200, 'Completely different operative text now.', { 'content-type': 'text/plain' })],
        ['soft-404', () => resp(200, 'Page not found. The page you requested does not exist.', { 'content-type': 'text/html' })],
        ['moved', () => resp(301, '', { location: 'https://example.test/doc-v2' })],
        ['removed', () => resp(410)],
        ['blocked', () => resp(403, '', { 'cf-ray': 'abc123' })],
        ['transient-error', () => resp(503, '', { 'retry-after': '120' })],
    ];
    for (const [expected, mk] of cases) {
        const out = await C.checkLiveness(cap, { fetchImpl: async () => mk(), now: () => new Date('2026-10-01T08:00:00Z') });
        check(`verdict ${expected}`, out.verdict === expected,
            `-> ${out.verdict}${out.final_url ? ' (' + out.final_url + ')' : ''} suggestion=${out.diagnostic.suggestion ?? '-'}`);
    }
    const netFail = await C.checkLiveness(cap, { fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
    check('network failure is a verdict, not an exception', netFail.verdict === 'transient-error');

    const challenge = await C.checkLiveness(cap, {
        fetchImpl: async () => resp(200, '<h1>Just a moment...</h1> Checking your browser', { 'content-type': 'text/html' }),
    });
    check('challenge interstitial -> blocked, not altered', challenge.verdict === 'blocked');

    console.log('\n=== 7. blocked/transient never imply removed ===');
    check('isDocumentVerdict(blocked) === false', C.isDocumentVerdict('blocked') === false);
    check('isDocumentVerdict(transient-error) === false', C.isDocumentVerdict('transient-error') === false);
    check('isDocumentVerdict(removed) === true', C.isDocumentVerdict('removed') === true);

    console.log('\n=== 8. Liveness record signs into the same chain ===');
    const lr = await C.createLiveness(netFail, chain, key); chain = lr.chain;
    const all = [...records, lr.record];
    v = await C.verifyChain(all, key.publicKeyRaw);
    check('mixed capture+liveness chain verifies', v.ok && v.verified === 3, JSON.stringify(v.issues));
    console.log('  path:', C.recordPath(SIGNER, lr.record));

    removeSignerKeys(SIGNER);
    console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => {
    console.error('HARNESS ERROR:', e);
    removeSignerKeys(SIGNER);
    process.exit(1);
});
