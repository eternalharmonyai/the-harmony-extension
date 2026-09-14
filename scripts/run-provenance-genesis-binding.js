#!/usr/bin/env node
/**
 * Provenance suite: genesis-binding
 * HERMETIC — no network. Safe to gate merges.
 *
 * Promoted from a scratch harness so the verification evidence lives with the code it
 * verifies, and can be re-run by anyone. Requires a build first: npm run compile
 */
const HARMONY_ROOT = require('path').resolve(__dirname, '..');
const { generateSignerKeys, signerKeyPaths } = require(HARMONY_ROOT + '/scripts/lib/keys.js');
// R2: does the in-chain genesis binding actually defeat repository compromise?
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const REPO = HARMONY_ROOT;
const C = require(REPO + '/out/citationRecord.js');
const W = require(REPO + '/out/webBotAuth.js');

const V = 'r2test';
const kp = n => signerKeyPaths(n);
let fails = 0;
const check = (n, c, x) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); if (!c) fails++; };
const cleanup = () => { for (const n of [V, 'attacker']) kp(n).forEach(f => { try { fs.rmSync(f, { force: true }); } catch {} }); };

const rawFromHex = h => new Uint8Array((h.match(/../g) || []).map(x => parseInt(x, 16)));
const hexFromRaw = r => [...r].map(b => b.toString(16).padStart(2, '0')).join('');

(async () => {
    for (const n of [V, 'attacker']) await generateSignerKeys(n);
    const [privP, recP, pubP] = kp(V);
    const pubText = fs.readFileSync(pubP, 'utf8');
    const principal = await W.loadSigningKey(fs.readFileSync(privP, 'utf8'), pubText);
    const recoveryRaw = C.recoveryKeyFromPub(pubText);
    const recPub = `signer: ${V}-rec\nalgorithm: ed25519\npublic_key: ${hexFromRaw(recoveryRaw)}\n`;
    const recovery = await W.loadSigningKey(fs.readFileSync(recP, 'utf8'), recPub);

    // The attacker holds a key of their own — but NOT the principal's.
    const [aPriv, , aPub] = kp('attacker');
    const attacker = await W.loadSigningKey(fs.readFileSync(aPriv, 'utf8'), fs.readFileSync(aPub, 'utf8'));

    console.log('=== 1. Chain opened with an in-chain genesis binding ===');
    const g = await C.startChain(principal, recoveryRaw, '2026-09-05T00:00:00Z');
    let chain = g.chain;
    const records = [g.record];
    for (let i = 1; i <= 3; i++) {
        const r = await C.createCapture({
            url: `https://example.test/doc${i}`, retrieved: '2026-09-05',
            retrieved_at: `2026-09-05T0${i}:00:00Z`, http_status: 200,
            content_sha256: await C.contentHash(`doc ${i}`), normalization: C.NORMALIZATION,
            evidence_tier: 'content', retrieval_class: 'harvest',
            observer: { signer: V, jurisdiction: 'US' },
        }, chain, principal);
        chain = r.chain; records.push(r.record);
    }
    check('genesis is seq 1', records[0].seq === 1 && records[0].harmony_record === 'genesis/1');
    check('binding recorded in-chain', records[0].body.recovery_keyid === recovery.keyid);
    check('chain of 4 verifies', (await C.verifyChain(records, principal.publicKeyRaw)).ok);

    let v = await C.verifyChainWithRevocation(records, principal.publicKeyRaw, {
        recoveryPublicKeyRaw: recoveryRaw, revocationDataAsOf: '2026-09-20T00:00:00Z',
    });
    check('binding reported as in-chain', v.revocation.binding === 'in-chain', v.revocation.binding);

    console.log('\n=== 2. THE R2 ATTACK: rewrite .pub to the attacker key ===');
    // Attacker controls the repo, not the signing key. They swap the sidecar binding
    // and issue a revocation signed by their own key.
    const forgedRevocation = await C.createRevocation({
        revokes_keyid: principal.keyid, signer: V, revoked_at: '2026-09-22T00:00:00Z',
        valid_through: null, reason: 'compromise', note: 'forged by repo attacker',
    }, attacker);

    v = await C.verifyChainWithRevocation(records, principal.publicKeyRaw, {
        revocation: forgedRevocation,
        recoveryPublicKeyRaw: attacker.publicKeyRaw,   // the rewritten .pub
        revocationDataAsOf: '2026-09-22T00:00:00Z',
    });
    check('forged revocation NOT applied', v.revocation.revoked === false);
    check('sidecar/genesis mismatch detected',
        v.issues.some(i => /does not match the in-chain genesis binding/.test(i.problem)),
        '-> ' + (v.issues.find(i => /genesis binding/.test(i.problem))?.problem ?? 'none'));
    check('records remain verified, not suspect', v.statuses.every(s => s.status === 'verified'));

    console.log('\n=== 3. Attacker rewrites genesis instead -> chain breaks ===');
    const tampered = JSON.parse(JSON.stringify(records));
    tampered[0].body.recovery_keyid = attacker.keyid;
    const tv = await C.verifyChain(tampered, principal.publicKeyRaw);
    check('editing genesis breaks the chain', !tv.ok);
    check('and every later record fails to link',
        tv.issues.filter(i => /id does not match|prev does not link|signature does not verify/.test(i.problem)).length >= 2,
        `${tv.issues.length} issue(s)`);

    console.log('\n=== 4. The legitimate recovery key still works ===');
    const realRevocation = await C.createRevocation({
        revokes_keyid: principal.keyid, signer: V, revoked_at: '2026-09-22T00:00:00Z',
        valid_through: records[2].id, reason: 'compromise',
    }, recovery);
    v = await C.verifyChainWithRevocation(records, principal.publicKeyRaw, {
        revocation: realRevocation, recoveryPublicKeyRaw: recoveryRaw,
        revocationDataAsOf: '2026-09-22T00:00:00Z',
    });
    check('genuine revocation applied', v.revocation.revoked === true);
    check('binding still in-chain', v.revocation.binding === 'in-chain');
    console.log('  statuses:', v.statuses.map(s => `${s.seq}:${s.status}`).join(' '));
    check('split at valid_through (genesis+2 verified, last suspect)',
        v.statuses[0].status === 'verified' && v.statuses[2].status === 'verified' && v.statuses[3].status === 'suspect');
    check('no spurious issues', v.issues.length === 0, JSON.stringify(v.issues));

    console.log('\n=== 5. Legacy chain with no genesis: works, but says so ===');
    const legacy = records.slice(1).map((r, i) => ({ ...r }));
    // Rebuild a genesis-less chain so linkage is self-consistent.
    let lc = C.emptyChain(V, principal.keyid);
    const legacyRecords = [];
    for (let i = 1; i <= 2; i++) {
        const r = await C.createCapture({
            url: `https://example.test/legacy${i}`, retrieved: '2026-09-05',
            retrieved_at: `2026-09-05T0${i}:00:00Z`, http_status: 200,
            content_sha256: await C.contentHash(`legacy ${i}`), normalization: C.NORMALIZATION,
            evidence_tier: 'content', retrieval_class: 'harvest',
            observer: { signer: V },
        }, lc, principal);
        lc = r.chain; legacyRecords.push(r.record);
    }
    v = await C.verifyChainWithRevocation(legacyRecords, principal.publicKeyRaw, {
        recoveryPublicKeyRaw: recoveryRaw,
    });
    check('legacy chain still verifies', v.issues.length === 0, JSON.stringify(v.issues));
    check('binding reported as sidecar-only', v.revocation.binding === 'sidecar-only', v.revocation.binding);

    console.log('\n=== 6. Genesis constructor guards ===');
    let threw = 0;
    try { await C.createGenesis({ signer: V, keyid: 'wrong', recovery_keyid: recovery.keyid, created_at: 'x' }, principal); } catch { threw++; }
    try { await C.createGenesis({ signer: V, keyid: principal.keyid, recovery_keyid: principal.keyid, created_at: 'x' }, principal); } catch { threw++; }
    check('rejects wrong keyid and self-as-recovery', threw === 2);

    cleanup();
    console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); cleanup(); process.exit(1); });
