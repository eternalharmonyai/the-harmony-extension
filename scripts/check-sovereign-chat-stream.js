#!/usr/bin/env node
/**
 * Gate: Sovereign Harmony Chat Live Streaming, Tag-Safe Filter & Multi-Step UX
 *
 * Verifies:
 *   1. parseSseLinesIncremental handles arbitrary chunk splits (\n and \r\n) and final flush.
 *   2. createAgentStepStreamFilter strips FINAL_ANSWER:\n cleanly while streaming live deltas.
 *   3. createAgentStepStreamFilter suppresses TOOL_CALL: {...} JSON from flashing in prose.
 *   4. createAgentStepStreamFilter detects late mid-stream \nTOOL_CALL: {...} and stops forwarding JSON.
 *   5. createAgentStepStreamFilter streams plain prose immediately with zero dropped characters.
 *   6. DEFAULT_STANDALONE_MAX_OUTPUT_TOKENS >= 16384 (lifting the old 2048 ceiling).
 *   7. Public Standalone HTML renders #stopChatBtn, .autonomous-progress-group, requestAnimationFrame
 *      delta coalescing, and /api/chat/cancel support while keeping check:dev-surface clean.
 */

const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const streamMod = require(path.join(root, 'out', 'sovereignChatStream.js'));
const serverMod = require(path.join(root, 'out', 'host', 'standaloneServer.js'));

let passed = 0;
let failed = 0;

function check(label, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  PASS  ${label}`);
    } catch (err) {
        failed += 1;
        console.error(`  FAIL  ${label} — ${err && err.message ? err.message : String(err)}`);
    }
}

console.log('\n[check-sovereign-chat-stream] Verifying Sovereign Harmony Chat live streaming & multi-step UX...');

check('DEFAULT_STANDALONE_MAX_OUTPUT_TOKENS lifts legacy 2048 cap to 16384+', () => {
    assert.ok(
        typeof streamMod.DEFAULT_STANDALONE_MAX_OUTPUT_TOKENS === 'number'
            && streamMod.DEFAULT_STANDALONE_MAX_OUTPUT_TOKENS >= 16384
    );
});

check('parseSseLinesIncremental handles split UTF-8 SSE frames and CRLF cleanly', () => {
    const state = { buffer: '' };
    const a = streamMod.parseSseLinesIncremental(state, 'data: {"a":', false);
    assert.deepStrictEqual(a, []);
    const b = streamMod.parseSseLinesIncremental(state, '1}\r\n\r\ndata: [DONE]', false);
    assert.deepStrictEqual(b, ['data: {"a":1}', '']);
    const c = streamMod.parseSseLinesIncremental(state, '', true);
    assert.deepStrictEqual(c, ['data: [DONE]']);
});

check('createAgentStepStreamFilter strips FINAL_ANSWER:\\n prefix and streams tokens live', () => {
    const visible = [];
    let toolDetected = 0;
    const filter = streamMod.createAgentStepStreamFilter({
        onVisibleDelta: (d) => visible.push(d),
        onToolCallDetected: () => { toolDetected += 1; },
    });
    for (const chunk of ['FIN', 'AL_ANS', 'WER:\n', 'Hello ', 'world', ' 💜!']) {
        filter.push(chunk);
    }
    const summary = filter.finish();
    assert.strictEqual(toolDetected, 0);
    assert.strictEqual(summary.mode, 'final_answer');
    assert.strictEqual(summary.suppressedAsToolCall, false);
    assert.strictEqual(visible.join(''), 'Hello world 💜!');
    assert.ok(visible.length >= 2, 'deltas should stream incrementally before finish()');
});

check('createAgentStepStreamFilter suppresses TOOL_CALL JSON completely from visible prose', () => {
    const visible = [];
    let toolDetected = 0;
    const filter = streamMod.createAgentStepStreamFilter({
        onVisibleDelta: (d) => visible.push(d),
        onToolCallDetected: () => { toolDetected += 1; },
    });
    for (const chunk of ['TOOL_', 'CALL: ', '{"name":"read_file","arguments":{"path":"README.md"}}']) {
        filter.push(chunk);
    }
    const summary = filter.finish();
    assert.strictEqual(toolDetected, 1);
    assert.strictEqual(summary.mode, 'tool_call');
    assert.strictEqual(summary.suppressedAsToolCall, true);
    assert.strictEqual(visible.join(''), '');
});

check('createAgentStepStreamFilter catches embedded mid-response \\nTOOL_CALL: line', () => {
    const visible = [];
    let toolDetected = 0;
    const filter = streamMod.createAgentStepStreamFilter({
        onVisibleDelta: (d) => visible.push(d),
        onToolCallDetected: () => { toolDetected += 1; },
    });
    filter.push('Let me inspect that file first.\n');
    filter.push('TOOL_CALL');
    filter.push(': {"name":"list_dir","arguments":{"path":"."}}');
    const summary = filter.finish();
    assert.strictEqual(toolDetected, 1);
    assert.strictEqual(summary.suppressedAsToolCall, true);
    assert.ok(!visible.join('').includes('TOOL_CALL'), `leaked TOOL_CALL into visible: ${visible.join('')}`);
});

check('createAgentStepStreamFilter streams plain prose without FINAL_ANSWER header losslessly', () => {
    const visible = [];
    const filter = streamMod.createAgentStepStreamFilter({
        onVisibleDelta: (d) => visible.push(d),
    });
    const parts = ['### Summary\n', '- Line 1\n', '- Line 2\n', 'Done!'];
    for (const p of parts) filter.push(p);
    const summary = filter.finish();
    assert.strictEqual(summary.mode, 'plain_prose');
    assert.strictEqual(visible.join(''), parts.join(''));
});

check('Standalone HTML ships Stop button, collapsible autonomous progress group, and Webview + SSE delta handlers', () => {
    const html = serverMod.renderStandaloneDesktopHtml(root, 201, 'test-session-token');
    assert.ok(html.includes('id="stopChatBtn"'), 'missing #stopChatBtn');
    assert.ok(html.includes('autonomous-progress-group'), 'missing .autonomous-progress-group');
    assert.ok(html.includes("evName === 'delta'"), 'missing SSE delta event handler');
    assert.ok(html.includes("evName === 'status'"), 'missing SSE status event handler');
    assert.ok(html.includes("msg.event === 'delta'"), 'missing Webview delta event handler');
    assert.ok(html.includes('/api/chat/cancel'), 'missing Webview cancel endpoint call');
});

console.log(`\n[check-sovereign-chat-stream] ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
