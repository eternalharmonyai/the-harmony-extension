#!/usr/bin/env node
/**
 * Provenance suite: mcp
 * INTEGRATION — reaches the network. Must never gate a merge.
 *
 * Promoted from a scratch harness so the verification evidence lives with the code it
 * verifies, and can be re-run by anyone. Requires a build first: npm run compile
 */
const HARMONY_ROOT = require('path').resolve(__dirname, '..');
const { removeSignerKeys, generateSignerKeys, signerKeyPaths } = require(HARMONY_ROOT + '/scripts/lib/keys.js');
// Drives bin/harmony-citation-mcp.js over real stdio, as an MCP client would.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const C = require(HARMONY_ROOT + '/out/citationRecord.js');
const W = require(HARMONY_ROOT + '/out/webBotAuth.js');
const S = require(HARMONY_ROOT + '/out/citationStore.js');

const REPO = HARMONY_ROOT;
const SIGNER_A = 'scout-us', SIGNER_B = 'scout-eu';
const ROOT = path.join(os.tmpdir(), 'harmony-citations-test-' + Date.now());

let fails = 0;
const check = (n, c, x) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); if (!c) fails++; };

function keyPaths(v) {
    const [priv, , pub] = signerKeyPaths(v);
    return [priv, pub];
}

async function buildFixture() {
    for (const v of [SIGNER_A, SIGNER_B]) {
        await generateSignerKeys(v);
    }
    fs.mkdirSync(path.join(ROOT, 'keys'), { recursive: true });

    const url = 'https://example.org/record/5788';
    const textUS = 'Example document operative text from the Committee.';
    const textEU = 'Example document operative text [content withheld in this region].';

    for (const [signer, text, jur] of [[SIGNER_A, textUS, 'US'], [SIGNER_B, textEU, 'EU']]) {
        const [pk, pub] = keyPaths(signer);
        const key = await W.loadSigningKey(fs.readFileSync(pk, 'utf8'), fs.readFileSync(pub, 'utf8'));
        fs.copyFileSync(pub, path.join(ROOT, 'keys', `${signer}.pub`));
        let chain = C.emptyChain(signer, key.keyid);

        const cap = await C.createCapture({
            url, retrieved: '2026-09-05', retrieved_at: `2026-09-05T09:0${signer === SIGNER_A ? 1 : 2}:00Z`,
            http_status: 200, content_sha256: await C.contentHash(text),
            normalization: C.NORMALIZATION, evidence_tier: 'content', retrieval_class: 'harvest',
            engine: 'primary:example.org', jurisdiction: 'institutional',
            observer: { signer, jurisdiction: jur }, verbatim: text,
        }, chain, key);
        chain = cap.chain;
        await S.appendRecord(ROOT, signer, cap.record);

        // A hash-only capture: proves without redistributing.
        const cap2 = await C.createCapture({
            url: 'https://example.org/record/2233', retrieved: '2026-09-05',
            retrieved_at: '2026-09-05T09:05:00Z', http_status: 200,
            content_sha256: await C.contentHash('some other operative text'),
            normalization: C.NORMALIZATION, evidence_tier: 'content', retrieval_class: 'harvest',
            observer: { signer, jurisdiction: jur },
        }, chain, key);
        chain = cap2.chain;
        await S.appendRecord(ROOT, signer, cap2.record);

        // Liveness history: one genuine removal, one blocked (must never count as absence).
        for (const body of [
            { capture: cap.record.id, url: 'https://example.test/gone', checked_at: '2026-09-10T00:00:00Z',
              verdict: 'removed', http_status: 410, baseline_sha256: 'abc', diagnostic: { retry_count: 0 } },
            { capture: cap.record.id, url: 'https://example.org/doc', checked_at: '2026-09-11T00:00:00Z',
              verdict: 'blocked', http_status: 403, baseline_sha256: 'abc', diagnostic: { retry_count: 0 } },
        ]) {
            const lr = await C.createLiveness(body, chain, key);
            chain = lr.chain;
            await S.appendRecord(ROOT, signer, lr.record);
        }
    }
    return url;
}

function client() {
    const proc = spawn('node', [path.join(REPO, 'bin/harmony-citation-mcp.js'), ROOT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const pending = new Map();
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line) continue;
            const msg = JSON.parse(line);
            const r = pending.get(msg.id);
            if (r) { pending.delete(msg.id); r(msg); }
        }
    });
    let id = 0;
    return {
        proc,
        rpc(method, params) {
            const myId = ++id;
            return new Promise(res => {
                pending.set(myId, res);
                proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
            });
        },
        notify(method, params) { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); },
        close() { proc.stdin.end(); proc.kill(); },
    };
}

(async () => {
    const url = await buildFixture();
    const c = client();
    const parse = r => JSON.parse(r.result.content[0].text);

    console.log('=== 1. MCP handshake ===');
    const init = await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    console.log('  serverInfo:', JSON.stringify(init.result.serverInfo), '| protocol:', init.result.protocolVersion);
    check('initialize returns capabilities.tools', !!init.result.capabilities.tools);
    c.notify('notifications/initialized');

    const list = await c.rpc('tools/list');
    console.log('  tools:', list.result.tools.map(t => t.name).join(', '));
    check('tools/list returns the 4 spec methods',
        ['verify_citation', 'check_liveness', 'get_captures', 'list_absences'].every(n => list.result.tools.some(t => t.name === n)));

    console.log('\n=== 2. verify_citation ===');
    let r = parse(await c.rpc('tools/call', { name: 'verify_citation', arguments: { url, quote: 'Example Committee' } }));
    console.log('  observers:', r.observers.map(o => `${o.signer}(${o.jurisdiction}) matches=${o.quote_matches}`).join(', '));
    check('found across both observers', r.found && r.observers.length === 2);
    check('citable_as_authority true (content tier, harvest class)', r.citable_as_authority === true);
    check('US observer confirms the quote', r.observers.find(o => o.jurisdiction === 'US').quote_matches === true);
    check('EU observer does NOT confirm it', r.observers.find(o => o.jurisdiction === 'EU').quote_matches === false);

    console.log('\n=== 3. hash-only record returns null, never false ===');
    r = parse(await c.rpc('tools/call', { name: 'verify_citation', arguments: { url: 'https://example.org/record/2233', quote: 'anything at all' } }));
    check('quote_matches === null (not false)', r.observers.every(o => o.quote_matches === null),
        JSON.stringify(r.observers.map(o => o.quote_matches)));
    check('flagged hash_only', r.observers.every(o => o.hash_only === true));

    console.log('\n=== 4. get_captures -> differential retrieval signal ===');
    r = parse(await c.rpc('tools/call', { name: 'get_captures', arguments: { url } }));
    console.log('  distinct hashes:', r.distinct_content_hashes, '| jurisdictions:', r.jurisdictions.join(','));
    check('two observers disagree on content', r.distinct_content_hashes === 2);
    check('divergence surfaced explicitly', typeof r.differential === 'string');

    console.log('\n=== 5. list_absences — blocked must NOT count as absence ===');
    r = parse(await c.rpc('tools/call', { name: 'list_absences', arguments: {} }));
    console.log('  absences:', r.absences.map(a => `${a.verdict}`).join(','), '| unverifiable:', r.unverifiable.length);
    check('removed listed as absence', r.absences.some(a => a.verdict === 'removed'));
    check('blocked excluded from absences by default', !r.absences.some(a => a.verdict === 'blocked'));
    r = parse(await c.rpc('tools/call', { name: 'list_absences', arguments: { include_unverifiable: true } }));
    check('blocked appears only in a separate unverifiable list',
        r.unverifiable.some(u => u.verdict === 'blocked') && !r.absences.some(a => a.verdict === 'blocked'));

    console.log('\n=== 6. SSRF guard ===');
    for (const bad of ['http://127.0.0.1:8080/admin', 'http://169.254.169.254/latest/meta-data/',
                       'http://localhost/x', 'file:///etc/passwd', 'http://192.168.1.1/']) {
        const res = parse(await c.rpc('tools/call', { name: 'check_liveness', arguments: { url: bad } }));
        check(`refused ${bad}`, /refused|not a valid/.test(res.error ?? ''), '-> ' + (res.error ?? 'ALLOWED'));
    }

    console.log('\n=== 7. check_liveness (live) ===');
    const live = parse(await c.rpc('tools/call', { name: 'check_liveness', arguments: { url, baseline_sha256: 'deadbeef' } }));
    console.log(`  verdict=${live.verdict} describes=${live.describes}`);
    check('live URL yields a document verdict', live.describes === 'document');
    const blocked = parse(await c.rpc('tools/call', { name: 'check_liveness', arguments: { url: 'https://example.org/sitemap.xml', baseline_sha256: 'deadbeef' } }));
    console.log(`  blocked verdict=${blocked.verdict} describes=${blocked.describes}`);
    check('403 -> network-path, with a note', blocked.describes === 'network-path' && /NOT evidence/.test(blocked.note ?? ''));

    console.log('\n=== 8. store verification + protocol errors ===');
    r = parse(await c.rpc('tools/call', { name: 'verify_store', arguments: {} }));
    console.log('  chains:', r.chains.map(x => `${x.signer}:${x.verified ? 'ok' : 'FAIL'}(${x.records})`).join(', '));
    check('both signed chains verify', r.chains.length === 2 && r.chains.every(x => x.verified));
    const unknown = await c.rpc('tools/call', { name: 'no_such_tool', arguments: {} });
    check('unknown tool -> isError result, not a dead connection', unknown.result.isError === true);
    const badMethod = await c.rpc('totally/unknown');
    check('unknown method -> JSON-RPC -32601', badMethod.error?.code === -32601);
    const stillAlive = await c.rpc('ping');
    check('server still responsive after errors', !!stillAlive.result);

    c.close();
    removeSignerKeys(SIGNER_A, SIGNER_B);
    fs.rmSync(ROOT, { recursive: true, force: true });
    console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
    process.exit(fails === 0 ? 0 : 1);
})().catch(e => {
    console.error('HARNESS ERROR:', e);
    try {
        removeSignerKeys(SIGNER_A, SIGNER_B);
        fs.rmSync(ROOT, { recursive: true, force: true });
    } catch {}
    process.exit(1);
});
