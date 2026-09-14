#!/usr/bin/env node
/**
 * Provenance suite: endpoint-config
 * HERMETIC — no network. Safe to gate merges.
 *
 * Promoted from a scratch harness so the verification evidence lives with the code it
 * verifies, and can be re-run by anyone. Requires a build first: npm run compile
 */
const HARMONY_ROOT = require('path').resolve(__dirname, '..');
const E = require(HARMONY_ROOT + '/out/endpointConfig.js');
let fails = 0;
const check = (n, c, x) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); if (!c) fails++; };
const parse = o => E.parseEndpointConfig(typeof o === 'string' ? o : JSON.stringify(o));

console.log('=== 1. A good config ===');
let r = parse({
    version: 1,
    institutional: [{ domain: 'repo.myuni.edu', label: 'My University', strategy: 'oai-pmh',
                      endpoint: 'https://repo.myuni.edu/oai', jurisdiction: 'institutional' }],
    engines: [{ id: 'searx-public', label: 'Public SearXNG', kind: 'searxng',
                baseUrl: 'https://searx.example.org', jurisdiction: 'independent',
                api_key_ref: 'HARMONY_SEARX_KEY', expected_requests_per_minute: 20 }],
});
check('valid config parses', r.ok && r.institutional !== undefined || r.ok, JSON.stringify(r.problems));
check('institutional source kept', r.config.institutional.length === 1);
check('engine kept', r.config.engines.length === 1);

console.log('\n=== 2. Self-hosted loopback: allowed, but only deliberately ===');
r = parse({ version: 1, engines: [{ id: 'local', kind: 'searxng', baseUrl: 'http://127.0.0.1:8888', jurisdiction: 'independent' }] });
check('loopback WITHOUT allow_private is rejected', !r.ok);
check('and the message explains how to allow it',
    /allow_private/.test(r.problems[0].problem), '-> ' + r.problems[0].problem.slice(0, 70) + '…');
r = parse({ version: 1, engines: [{ id: 'local', kind: 'searxng', baseUrl: 'http://127.0.0.1:8888', jurisdiction: 'independent', allow_private: true }] });
check('loopback WITH allow_private is accepted', r.ok && r.config.engines.length === 1);
check('no plaintext-http warning for a private host', !r.problems.some(p => /plaintext/.test(p.problem)));

console.log('\n=== 3. Inline secrets are refused (config files get committed) ===');
for (const bad of ['sk-abc123def456ghi789jkl012mno345pq', 'AIzaSyD-1234567890abcdefghijklmno',
                   'a3f5c8e9b2d4a6f8c1e3b5d7a9f2c4e6', 'eyJhbGciOiJIUzI1NiJ9.payload']) {
    r = parse({ version: 1, engines: [{ id: 'e', kind: 'custom', baseUrl: 'https://x.example', api_key_ref: bad }] });
    check(`rejected inline secret ${bad.slice(0, 14)}…`, !r.ok);
}
r = parse({ version: 1, engines: [{ id: 'e', kind: 'custom', baseUrl: 'https://x.example', api_key_ref: 'MY_API_KEY_NAME' }] });
check('a plain NAME is accepted', r.ok, JSON.stringify(r.problems));

console.log('\n=== 4. One bad entry must not lose the good ones ===');
r = parse({
    version: 1,
    engines: [
        { id: 'good1', kind: 'searxng', baseUrl: 'https://a.example', jurisdiction: 'independent' },
        { id: 'bad', kind: 'nonsense', baseUrl: 'not-a-url' },
        { id: 'good2', kind: 'opensearch', baseUrl: 'https://b.example', jurisdiction: 'EU' },
    ],
});
check('both valid engines survive', r.config.engines.length === 2,
    r.config.engines.map(e => e.id).join(','));
check('the invalid one is reported', !r.ok && r.problems.some(p => /engines\[1\]/.test(p.where)));

console.log('\n=== 5. Malformed input never throws ===');
for (const [name, input] of [['not json', '{oops'], ['array at top', '[]'], ['null', 'null'],
                             ['wrong version', '{"version":2}'], ['empty', '{"version":1}']]) {
    let threw = false, res;
    try { res = parse(input); } catch { threw = true; }
    check(`${name} handled without throwing`, !threw && res !== undefined);
}

console.log('\n=== 6. Duplicates and warnings ===');
r = parse({ version: 1, engines: [
    { id: 'dup', kind: 'custom', baseUrl: 'https://a.example' },
    { id: 'dup', kind: 'custom', baseUrl: 'https://b.example' },
] });
check('duplicate id rejected', r.problems.some(p => /duplicate/.test(p.problem)));
r = parse({ version: 1, engines: [{ id: 'e', kind: 'custom', baseUrl: 'http://public.example', jurisdiction: 'US' }] });
check('plaintext http to a PUBLIC host warns but does not fail',
    r.ok && r.problems.some(p => p.severity === 'warning' && /plaintext/.test(p.problem)));
r = parse({ version: 1, engines: [{ id: 'e', kind: 'custom', baseUrl: 'https://a.example', expected_requests_per_minute: 600 }] });
check('aggressive rate warns, does not fail', r.ok && r.problems.some(p => /aggressive/.test(p.problem)));
r = parse({ version: 1, engines: [{ id: 'e', kind: 'custom', baseUrl: 'https://a.example', jurisdiction: 'Atlantis' }] });
check('unknown jurisdiction degrades to "unknown" with a warning',
    r.ok && r.config.engines[0].jurisdiction === 'unknown');

console.log('\n=== 7. Adapter shaping ===');
r = parse({ version: 1, institutional: [
    { domain: 'a.edu', strategy: 'oai-pmh', endpoint: 'https://a.edu/oai' },
    { domain: 'b.org', strategy: 'sitemap', origin: 'https://b.org' },
] });
const sources = E.toInstitutionalSources(r.config);
check('shapes into InstitutionalSource', sources.length === 2 && sources[0].endpoint && sources[1].origin);
console.log('  ' + JSON.stringify(sources[0]));
console.log('\n  formatProblems sample:');
console.log('  ' + E.formatProblems(parse({ version: 1, engines: [{ id: 'x', kind: 'bad', baseUrl: 'http://10.0.0.1' }] }).problems).split('\n').join('\n  '));

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
