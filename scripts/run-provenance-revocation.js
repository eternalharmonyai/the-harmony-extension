#!/usr/bin/env node
/**
 * Provenance suite: revocation
 * HERMETIC — no network. Safe to gate merges.
 *
 * Promoted from a scratch harness so the verification evidence lives with the code it
 * verifies, and can be re-run by anyone. Requires a build first: npm run compile
 */
const HARMONY_ROOT = require('path').resolve(__dirname, '..');
const { generateSignerKeys, signerKeyPaths } = require(HARMONY_ROOT + '/scripts/lib/keys.js');
// Revocation §11: the three endorsed properties, tested as properties.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const REPO = HARMONY_ROOT;
const C = require(REPO + '/out/citationRecord.js');
const W = require(REPO + '/out/webBotAuth.js');

const SIGNER = 'revtest';
const [priv, rec, pub] = signerKeyPaths(SIGNER);

let fails = 0;
const check = (n, c, x) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); if (!c) fails++; };
const cleanup = () => [priv, rec, pub].forEach(p => { try { fs.rmSync(p, { force: true }); } catch {} });

(async () => {
    await generateSignerKeys(SIGNER);
    const pubText = fs.readFileSync(pub, 'utf8');

    console.log('=== 1. Recovery key is bound at generation, before any compromise ===');
    const recoveryRaw = C.recoveryKeyFromPub(pubText);
    check('recovery_public_key published in .pub', recoveryRaw instanceof Uint8Array && recoveryRaw.length === 32);
    check('recovery private key written', fs.existsSync(rec));

    const principal = await W.loadSigningKey(fs.readFileSync(priv, 'utf8'), pubText);
    // The recovery key's own .pub-equivalent, derived from the published binding.
    const recoveryPubText = `signer: ${SIGNER}-recovery\nalgorithm: ed25519\npublic_key: ${[...recoveryRaw].map(b => b.toString(16).padStart(2, '0')).join('')}\n`;
    const recovery = await W.loadSigningKey(fs.readFileSync(rec, 'utf8'), recoveryPubText);
    check('recovery keyid differs from principal', recovery.keyid !== principal.keyid);

    console.log('\n=== 2. Build a 4-record chain ===');
    let chain = C.emptyChain(SIGNER, principal.keyid);
    const records = [];
    for (let i = 1; i <= 4; i++) {
        const r = await C.createCapture({
            url: `https://example.test/doc${i}`, retrieved: '2026-09-05',
            retrieved_at: `2026-09-05T0${i}:00:00Z`, http_status: 200,
            content_sha256: await C.contentHash(`document ${i}`),
            normalization: C.NORMALIZATION, evidence_tier: 'content', retrieval_class: 'harvest',
            observer: { signer: SIGNER, jurisdiction: 'US' },
        }, chain, principal);
        chain = r.chain; records.push(r.record);
    }
    check('chain of 4 verifies', (await C.verifyChain(records, principal.publicKeyRaw)).ok);

    console.log('\n=== 3. DECISION 3: absence of revocation is not evidence of non-revocation ===');
    let v = await C.verifyChainWithRevocation(records, principal.publicKeyRaw, {});
    check('no revocation data -> revoked:false', v.revocation.revoked === false);
    check('note refuses to imply the key is good',
        /cannot distinguish/.test(v.revocation.note), '-> ' + v.revocation.note.slice(0, 62) + '…');
    check('data_as_of null when never refreshed', v.revocation.data_as_of === null);
    v = await C.verifyChainWithRevocation(records, principal.publicKeyRaw, { revocationDataAsOf: '2026-09-20T00:00:00Z' });
    check('refreshed -> states as-of date + the caveat',
        /not evidence of non-revocation/.test(v.revocation.note) && v.revocation.data_as_of === '2026-09-20T00:00:00Z');

    console.log('\n=== 4. DECISION 1: signed by recovery key, never self-signed ===');
    const body = {
        revokes_keyid: principal.keyid, signer: SIGNER, revoked_at: '2026-09-21T00:00:00Z',
        valid_through: records[1].id, reason: 'compromise',
        note: 'principal key exposed in a leaked backup',
    };
    let selfSigned = false;
    try { await C.createRevocation(body, principal); } catch (e) { selfSigned = true; console.log('  ' + e.message.split(':')[0]); }
    check('creating a self-signed revocation is refused', selfSigned);

    const revocation = await C.createRevocation(body, recovery);
    check('revocation signed by recovery key', revocation.signature.keyid === recovery.keyid);
    check('revocation verifies against published binding',
        (await C.verifyRevocation(revocation, recoveryRaw)).ok);

    const wrongKey = await C.verifyRevocation(revocation, principal.publicKeyRaw);
    check('a revocation signed by the wrong key is rejected', !wrongKey.ok, '-> ' + wrongKey.reason);

    const tampered = JSON.parse(JSON.stringify(revocation));
    tampered.body.valid_through = null; // attacker widens the blast radius
    const t = await C.verifyRevocation(tampered, recoveryRaw);
    check('tampered revocation rejected', !t.ok, '-> ' + t.reason);

    console.log('\n=== 5. DECISION 2: suspect, not invalid — history survives ===');
    v = await C.verifyChainWithRevocation(records, principal.publicKeyRaw, {
        revocation, recoveryPublicKeyRaw: recoveryRaw, revocationDataAsOf: '2026-09-22T00:00:00Z',
    });
    console.log('  statuses:', v.statuses.map(s => `${s.seq}:${s.status}`).join(' '));
    check('revocation recognised', v.revocation.revoked === true);
    check('records 1-2 remain verified',
        v.statuses[0].status === 'verified' && v.statuses[1].status === 'verified');
    check('records 3-4 become suspect',
        v.statuses[2].status === 'suspect' && v.statuses[3].status === 'suspect');
    check('signatures still verify — revocation splits, it does not invalidate', v.verified === 4);
    check('no issues raised for a valid revocation', v.issues.length === 0, JSON.stringify(v.issues));

    console.log('\n=== 6. Unknown compromise point -> everything suspect ===');
    const wholeChain = await C.createRevocation({ ...body, valid_through: null }, recovery);
    v = await C.verifyChainWithRevocation(records, principal.publicKeyRaw, {
        revocation: wholeChain, recoveryPublicKeyRaw: recoveryRaw,
    });
    check('all 4 suspect', v.statuses.every(s => s.status === 'suspect'));
    check('note explains why', /unknown compromise point/.test(v.revocation.note));

    console.log('\n=== 7. A revocation for a different key is ignored, with an issue ===');
    const other = await W.loadSigningKey(fs.readFileSync(rec, 'utf8'), recoveryPubText);
    const mismatched = await C.createRevocation({ ...body, revokes_keyid: 'someone-elses-keyid' }, recovery);
    v = await C.verifyChainWithRevocation(records, principal.publicKeyRaw, {
        revocation: mismatched, recoveryPublicKeyRaw: recoveryRaw,
    });
    check('not applied to this chain', v.revocation.revoked === false);
    check('but reported as an issue', v.issues.some(i => /different key/.test(i.problem)));
    check('records stay verified', v.statuses.every(s => s.status === 'verified'));

    cleanup();
    console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); cleanup(); process.exit(1); });
