#!/usr/bin/env node
/**
 * Standalone verification for in-turn compaction (out/inTurnCompaction.js).
 * No VS Code host required — pure module, pure checks. Exit code 0 = all pass.
 *
 * Run:  node scripts/verify-in-turn-compaction.js
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const {
    planInTurnCompaction,
    deduplicateSupersededToolResults,
    OFFLOAD_MARKER,
    OFFLOAD_MARKER_PREFIX,
    MAX_HOLOGRAPHIC_STUB_CHARS,
    COMPACTION_KEEP_NEWEST_MESSAGES,
    isContextLengthError,
    extractHolographicSummary,
    buildHolographicStub,
    rehydrateSpilledToolResult,
} = require('../out/inTurnCompaction');

let pass = 0;
let fail = 0;
function check(name, cond) {
    if (cond) { pass += 1; console.log('PASS  ' + name); }
    else { fail += 1; console.log('FAIL  ' + name); }
}

const big = (n) => 'x'.repeat(n);

function freshMessages() {
    return [
        { role: 'system', content: 'sys ' + big(400) },
        { role: 'tool', tool_call_id: 't0', content: big(3000) },
        { role: 'assistant', content: 'ok 1' },
        { role: 'tool', tool_call_id: 't1', content: big(3000) },
        { role: 'assistant', content: 'ok 2' },
        { role: 'tool', tool_call_id: 't2', content: OFFLOAD_MARKER }, // already stubbed
        { role: 'assistant', content: 'ok 3' },
        { role: 'tool', tool_call_id: 't3', content: big(3000) },
        { role: 'assistant', content: 'ok 4' }, // ← newest-8 window starts (len 16, keep 8)
        { role: 'user', content: 'recent ask' },
        { role: 'tool', tool_call_id: 't4', content: big(3000) },
        { role: 'assistant', content: 'ok 5' },
        { role: 'tool', tool_call_id: 't5', content: big(3000) },
        { role: 'assistant', content: 'ok 6' },
        { role: 'tool', tool_call_id: 't6', content: big(3000) },
        { role: 'tool', tool_call_id: 't7', content: big(150) },
    ];
}

check('keep-newest constant is 8 (window width)', COMPACTION_KEEP_NEWEST_MESSAGES === 8);

// 1 — tiny target stubs exactly the oldest eligible message
{
    const m = freshMessages();
    const r = planInTurnCompaction(m, 100);
    check('tiny target: exactly 1 stub', r.stubbed === 1);
    check('tiny target: oldest eligible stubbed first', m[1].content === OFFLOAD_MARKER);
    check('tiny target: savings = content − marker', r.charsSaved === 3000 - OFFLOAD_MARKER.length);
    check('tiny target: next eligible untouched', m[3].content === big(3000));
}

// 2 — big target stubs all eligible (t0, t1, t3), skipping stubbed/protected/small
{
    const m = freshMessages();
    const r = planInTurnCompaction(m, 10_000_000);
    check('big target: exactly 3 stubs', r.stubbed === 3);
    check('big target: old t3 stubbed', m[7].content === OFFLOAD_MARKER);
    check('big target: newest window protected (t4, t5, t6)',
        m[10].content === big(3000) && m[12].content === big(3000) && m[14].content === big(3000));
    check('big target: already-stubbed t2 skipped and unchanged', m[5].content === OFFLOAD_MARKER);
    check('big target: savings = 3 × (3000 − marker)', r.charsSaved === 3 * (3000 - OFFLOAD_MARKER.length));
}

// 3 — pairing + structure preserved (never removes or reorders messages)
{
    const m = freshMessages();
    const idsBefore = m.map((x) => x.tool_call_id);
    planInTurnCompaction(m, 10_000_000);
    check('structure: message count unchanged', m.length === 16);
    check('structure: tool_call_ids unchanged', JSON.stringify(m.map((x) => x.tool_call_id)) === JSON.stringify(idsBefore));
    check('structure: system/user/assistant contents untouched',
        m[0].content.startsWith('sys ') && m[9].content === 'recent ask' && m[2].content === 'ok 1');
}

// 4 — idempotent: a second run stubs nothing
{
    const m = freshMessages();
    planInTurnCompaction(m, 10_000_000);
    const second = planInTurnCompaction(m, 10_000_000);
    check('idempotent: second run stubs 0', second.stubbed === 0 && second.charsSaved === 0);
}

// 5 — negative controls
{
    const m = freshMessages();
    const r0 = planInTurnCompaction(m, 0);
    check('negative: target 0 → no stubs, nothing changed', r0.stubbed === 0 && m[1].content === big(3000));

    const onlyProtected = freshMessages().slice(8); // length 8 == the keep-newest window
    const rp = planInTurnCompaction(onlyProtected, 10_000_000);
    check('negative: all-protected window → no stubs', rp.stubbed === 0);

    const short = [{ role: 'tool', tool_call_id: 's0', content: big(150) }];
    const rs = planInTurnCompaction(short, 10_000_000, 0);
    check('negative: content below the floor is never stubbed', rs.stubbed === 0 && short[0].content === big(150));

    const nonTool = [{ role: 'user', content: big(3000) }];
    const rn = planInTurnCompaction(nonTool, 10_000_000, 0);
    check('negative: non-tool roles are never stubbed', rn.stubbed === 0 && nonTool[0].content === big(3000));
}

// 6 — context-length classifier: HTTP 4xx + window wording, nothing else
{
    const live1 = `DeepSeek HTTP 400: {"error":{"message":"This model's maximum context length is 1048576 tokens. However, you requested 1067880 tokens (1067880 in the messages, 0 in the completion). Please reduce the length of the messages or completion.","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}`;
    const live2 = `DeepSeek HTTP 400: {"error":{"message":"This model's maximum context length is 1048576 tokens. However, you requested 1051706 tokens (1051706 in the messages, 0 in the completion). Please reduce the length of the messages or completion."}}`;
    const liveGemini = `Gemini Native HTTP 400: [{"error":{"code":400,"message":"The input token count exceeds the maximum number of tokens allowed 1048576.","status":"INVALID_ARGUMENT"}}]`;
    check('classifier: live 400 #1 (1,067,880) matched', isContextLengthError(live1) === true);
    check('classifier: live 400 #2 (1,051,706) matched', isContextLengthError(live2) === true);
    check('classifier: live Gemini 400 (1,048,576) matched', isContextLengthError(liveGemini) === true);
    check('classifier: reasoning-param 400 NOT matched', isContextLengthError('DeepSeek HTTP 400: reasoning_effort is not supported for this model') === false);
    check('classifier: plain network error NOT matched', isContextLengthError('fetch failed') === false);
    check('classifier: window wording on a 500 NOT matched (4xx only)', isContextLengthError('DeepSeek HTTP 500: maximum context length internal error') === false);
}

// 7 — Holographic Structural Stubs + Turn-Spill Rehydration (Leap V)
{
    const samplePayload = [
        'File: src/inTurnCompaction.ts:42:5',
        'export function planInTurnCompaction(messages: CompactionMessage[]) {',
        'export interface HolographicSummary { sha256Prefix: string; }',
        'Error: HTTP 400 ECONNRESET ERR_INVALID_ARG_TYPE',
        big(2500),
    ].join('\n');
    const summary = extractHolographicSummary(samplePayload);
    check('holographic: extracts SHA-256 12-char prefix', typeof summary.sha256Prefix === 'string' && summary.sha256Prefix.length === 12);
    check('holographic: extracts file:line reference', summary.files.includes('src/inTurnCompaction.ts:42:5'));
    check('holographic: extracts function/interface symbols', summary.symbols.includes('planInTurnCompaction') && summary.symbols.includes('HolographicSummary'));
    check('holographic: extracts HTTP and error codes', summary.codes.includes('HTTP 400') && summary.codes.includes('ECONNRESET'));

    const stub = buildHolographicStub(samplePayload, 'call_abc123');
    check('holographic: stub begins with OFFLOAD_MARKER_PREFIX (idempotency preserved)', stub.startsWith(OFFLOAD_MARKER_PREFIX));
    check('holographic: stub length is bounded <= MAX_HOLOGRAPHIC_STUB_CHARS', stub.length <= MAX_HOLOGRAPHIC_STUB_CHARS);

    const tmpSpill = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-spill-test-'));
    try {
        const msgs = [
            { role: 'tool', tool_call_id: 'call_abc123', content: samplePayload },
            ...freshMessages().slice(8),
        ];
        const r = planInTurnCompaction(msgs, 500, 8, { holographic: true, spillDir: tmpSpill });
        check('holographic compaction: stubs 1 and records spilledIds', r.stubbed === 1 && Array.isArray(r.spilledIds) && r.spilledIds[0] === 'call_abc123');
        check('holographic compaction: second run is idempotent', planInTurnCompaction(msgs, 500, 8, { holographic: true }).stubbed === 0);

        const sliceRes = rehydrateSpilledToolResult(tmpSpill, 'call_abc123', { startChar: 0, maxChars: 90 });
        check('holographic rehydration: restores exact character slice and sha256Prefix',
            sliceRes.ok === true && sliceRes.sha256Prefix === summary.sha256Prefix && sliceRes.slice.startsWith('File: src/inTurnCompaction.ts:42:5'));

        const grepRes = rehydrateSpilledToolResult(tmpSpill, 'call_abc123', { pattern: 'HolographicSummary' });
        check('holographic rehydration: pattern search locates matching line',
            grepRes.ok === true && Array.isArray(grepRes.matches) && grepRes.matches.length === 1 && grepRes.matches[0].startsWith('L3:'));
    } finally {
        fs.rmSync(tmpSpill, { recursive: true, force: true });
    }
}

// 8 — Frontier Cost Shield: Same-File Read Deduplication & Deterministic Gemini Prefix
{
    const { installVscodeHostShim } = require('../out/host/vscodeHostShim');
    installVscodeHostShim(process.cwd());
    const { convertToolsToGemini } = require('../out/geminiNativeStreaming');
    const { estimateCost } = require('../out/costTracker');

    const oldRead = big(2500);
    const coveringRead = big(2800);
    const msgs = [
        { role: 'user', content: 'Inspect foo.ts' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'harmony_read_file', arguments: JSON.stringify({ path: 'src/foo.ts', start_line: 10, end_line: 40 }) } }] },
        { role: 'tool', tool_call_id: 'c1', content: oldRead },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c2', function: { name: 'harmony_read_file', arguments: JSON.stringify({ path: 'src/foo.ts', start_line: 1, end_line: 100 }) } }] },
        { role: 'tool', tool_call_id: 'c2', content: coveringRead },
    ];
    const dedup = deduplicateSupersededToolResults(msgs);
    check('cost-shield dedup: stubs covered earlier read', dedup.stubbed === 1 && dedup.charsSaved > 2000);
    check('cost-shield dedup: preserves OFFLOAD_MARKER_PREFIX and newer read verbatim',
        msgs[2].content.startsWith(OFFLOAD_MARKER_PREFIX) && msgs[4].content === coveringRead);
    check('cost-shield dedup: idempotent on second pass', deduplicateSupersededToolResults(msgs).stubbed === 0);

    const toolsA = [
        { function: { name: 'harmony_z', description: 'Z', parameters: { type: 'object', properties: { b: { type: 'string' }, a: { type: 'number' } }, required: ['b', 'a'] } } },
        { function: { name: 'harmony_a', description: 'A', parameters: { type: 'object', properties: { y: { type: 'boolean' }, x: { type: 'string' } }, required: ['y', 'x'] } } },
    ];
    const toolsB = [
        { function: { name: 'harmony_a', description: 'A', parameters: { type: 'object', properties: { x: { type: 'string' }, y: { type: 'boolean' } }, required: ['x', 'y'] } } },
        { function: { name: 'harmony_z', description: 'Z', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'string' } }, required: ['a', 'b'] } } },
    ];
    check('cost-shield prefix: convertToolsToGemini produces byte-identical sorted schemas',
        JSON.stringify(convertToolsToGemini(toolsA)) === JSON.stringify(convertToolsToGemini(toolsB)));

    const uncached = estimateCost('gemini', 'gemini-4-argon', 100000, 2000);
    const cached = estimateCost('gemini', 'gemini-4-argon', 100000, 2000, 80000);
    check('cost-shield accounting: Gemini 75% cached prompt discount applied accurately',
        Math.abs(uncached - 0.135) < 1e-6 && Math.abs(cached - 0.06) < 1e-6);

    const carbonUncached = estimateCost('gemini', 'gemini-4-carbon', 100000, 2000);
    const carbonCached = estimateCost('gemini', 'gemini-4-carbon', 100000, 2000, 80000);
    check('cost-shield accounting: Gemini 4 Carbon uses frontier pricing + 75% cache discount',
        Math.abs(carbonUncached - 0.135) < 1e-6 && Math.abs(carbonCached - 0.06) < 1e-6);

    const hydrogenUncached = estimateCost('gemini', 'gemini-4-hydrogen', 100000, 2000);
    const hydrogenCached = estimateCost('gemini', 'gemini-4-hydrogen', 100000, 2000, 80000);
    check('cost-shield accounting: Gemini 4 Hydrogen uses fast/light pricing + 75% cache discount',
        Math.abs(hydrogenUncached - 0.0081) < 1e-6 && Math.abs(hydrogenCached - 0.0036) < 1e-6);

    const { resolveGeminiGenerateContentRequest } = require('../out/providers');
    const { convertMessagesToGeminiContents } = require('../out/geminiNativeStreaming');
    const aiStudioReq = resolveGeminiGenerateContentRequest('gemini-4-carbon', 'AIzaSyTestKey', 'streamGenerateContent', true);
    check('gemini endpoint resolver: default ai-studio targets generativelanguage.googleapis.com with x-goog-api-key header',
        aiStudioReq.backend === 'ai-studio'
        && aiStudioReq.url.includes('generativelanguage.googleapis.com/v1beta/models/gemini-4-carbon:streamGenerateContent?alt=sse')
        && aiStudioReq.headers['x-goog-api-key'] === 'AIzaSyTestKey');

    const bearerReq = resolveGeminiGenerateContentRequest('gemini-4-argon', 'ya29.a0AfH6SMTestToken', 'generateContent', false);
    check('gemini endpoint resolver: ya29.* OAuth token uses Authorization Bearer header',
        bearerReq.headers['Authorization'] === 'Bearer ya29.a0AfH6SMTestToken'
        && !bearerReq.headers['x-goog-api-key']);

    const unionTools = [
        { function: { name: 'harmony_union_test', description: 'Union param test', parameters: { type: 'object', properties: { nullableText: { type: ['string', 'null'] } } } } }
    ];
    const convertedUnion = convertToolsToGemini(unionTools);
    check('gemini schema converter: handles JSON-Schema union array type ["string","null"] without throwing',
        convertedUnion[0].parameters.properties.nullableText.type === 'STRING');

    const orphanHistory = convertMessagesToGeminiContents([
        { role: 'user', content: 'Hello' },
        { role: 'tool', tool_call_id: 'call_orphaned_123', content: 'Orphaned result' }
    ]);
    check('gemini history converter: degrades orphaned tool result to text instead of invalid functionResponse',
        orphanHistory.contents.every((c) => c.parts.every((p) => !p.functionResponse)));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
