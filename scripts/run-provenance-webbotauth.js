#!/usr/bin/env node
/**
 * Provenance suite: webbotauth
 * HERMETIC — no network. Safe to gate merges.
 *
 * Promoted from a scratch harness so the verification evidence lives with the code it
 * verifies, and can be re-run by anyone. Requires a build first: npm run compile
 */
const HARMONY_ROOT = require('path').resolve(__dirname, '..');
const { removeSignerKeys, generateSignerKeys, signerKeyPaths } = require(HARMONY_ROOT + '/scripts/lib/keys.js');
// End-to-end: generate a local signer keypair, then load and sign with it from
// TypeScript. Proves key reuse rather than asserting it.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const W = require(HARMONY_ROOT + '/out/webBotAuth.js');

const SIGNER = 'harvester';
const [priv, , pub] = signerKeyPaths(SIGNER);

let fails = 0;
const check = (name, cond, extra) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    if (!cond) fails++;
};

(async () => {
    console.log('=== 1. Generate a signer keypair ===');
    await generateSignerKeys(SIGNER);
    check('signer key files written', fs.existsSync(priv) && fs.existsSync(pub));

    console.log('\n=== 2. Load that exact key pair from TypeScript ===');
    const key = await W.loadSigningKey(fs.readFileSync(priv, 'utf8'), fs.readFileSync(pub, 'utf8'));
    console.log('signer:', key.signer, '| pubkey bytes:', key.publicKeyRaw.length);
    console.log('keyid (RFC 7638 JWK thumbprint):', key.keyid);
    check('signer parsed', key.signer === SIGNER);
    check('ed25519 public key is 32 bytes', key.publicKeyRaw.length === 32);

    console.log('\n=== 3. Sign a request ===');
    const url = 'https://example.org/oai2d?verb=Identify';
    const cfg = {
        directoryUrl: 'https://harmony.example/.well-known/http-message-signatures-directory',
        ttlSeconds: 300,
        now: () => 1789000000,
    };
    const headers = await W.signRequest(url, key, cfg);
    for (const [k, v] of Object.entries(headers)) {
        console.log(`  ${k}: ${v.length > 96 ? v.slice(0, 93) + '...' : v}`);
    }
    check('Signature-Input names the covered components',
        headers['Signature-Input'].includes('("@authority" "signature-agent")'));
    check('tag is web-bot-auth', headers['Signature-Input'].includes('tag="web-bot-auth"'));
    check('alg is ed25519', headers['Signature-Input'].includes('alg="ed25519"'));
    check('Signature is a byte-sequence field', /^sig1=:[A-Za-z0-9+/=]+:$/.test(headers['Signature']));

    console.log('\n=== 4. Signature base (the exact signed bytes) ===');
    const { base } = W.buildSignatureBase({
        authority: W.authorityOf(url), directoryUrl: cfg.directoryUrl,
        created: 1789000000, expires: 1789000300, keyid: key.keyid,
    });
    console.log(base.split('\n').map(l => '  | ' + (l.length > 100 ? l.slice(0, 97) + '...' : l)).join('\n'));
    check('authority excludes scheme/path/query', W.authorityOf(url) === 'example.org');
    check('base has no trailing newline', !base.endsWith('\n'));

    console.log('\n=== 5. Round-trip verify ===');
    const v = await W.verifySignature(url, headers, key.publicKeyRaw, { now: () => 1789000100 });
    check('valid signature verifies', v.ok, JSON.stringify(v));

    console.log('\n=== 6. Negative cases (each must FAIL to verify, with a reason) ===');
    const cases = [
        ['tampered authority', 'https://evil.example/oai2d', headers, key.publicKeyRaw, 1789000100],
        ['expired signature', url, headers, key.publicKeyRaw, 1789999999],
        ['wrong public key', url, headers, crypto.getRandomValues(new Uint8Array(32)), 1789000100],
    ];
    for (const [name, u, h, pk, now] of cases) {
        const r = await W.verifySignature(u, h, pk, { now: () => now });
        check(`rejected: ${name}`, r.ok === false, `-> ${r.reason}`);
    }
    const mangled = { ...headers, Signature: headers.Signature.replace(/.$/, 'X:') };
    const rm = await W.verifySignature(url, mangled, key.publicKeyRaw, { now: () => 1789000100 });
    check('rejected: mangled signature bytes', rm.ok === false, `-> ${rm.reason}`);

    console.log('\n=== 7. Published directory + agent card ===');
    const dir = JSON.parse(await W.buildKeyDirectory([key]));
    console.log('JWKS:', JSON.stringify(dir.keys[0]));
    check('JWKS kid matches keyid', dir.keys[0].kid === key.keyid);
    check('JWKS contains no private material',
        !JSON.stringify(dir).includes('PRIVATE') && dir.keys[0].d === undefined);
    const card = JSON.parse(await W.buildAgentCard({
        name: 'Harmony Source Harvest', operator: 'Example Operator LLC',
        contactUrl: 'https://harmony.example/crawler',
        expectedRequestsPerMinute: 6,
        description: 'Scoped institutional harvest; honours robots.txt and Crawl-delay.',
    }, [key]));
    console.log('Agent Card rate:', JSON.stringify(card.expected_request_rate));
    check('agent card declares a rate', card.expected_request_rate.requests === 6);

    console.log('\n=== 8. Cleanup (never leave a test key on disk) ===');
    removeSignerKeys(SIGNER);
    check('test key removed', !fs.existsSync(priv) && !fs.existsSync(pub));

    console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => {
    // Never leave a test key on disk, even when a step throws: the clean-up step only
    // runs on the success path, so this is the failure-path counterpart.
    try { removeSignerKeys(SIGNER); } catch { /* best effort */ }
    console.error('HARNESS ERROR:', e);
    process.exit(1);
});
