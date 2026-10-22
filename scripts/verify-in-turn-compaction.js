#!/usr/bin/env node
/**
 * Standalone verification for in-turn compaction (out/inTurnCompaction.js).
 * No VS Code host required — pure module, pure checks. Exit code 0 = all pass.
 *
 * Run:  node scripts/verify-in-turn-compaction.js
 */
'use strict';

const {
    planInTurnCompaction,
    OFFLOAD_MARKER,
    COMPACTION_KEEP_NEWEST_MESSAGES,
    isContextLengthError,
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
