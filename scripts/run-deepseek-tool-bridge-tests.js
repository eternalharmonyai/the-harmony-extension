#!/usr/bin/env node
/**
 * DeepSeek tool-call bridge unit and compiled-artifact tests.
 *
 * Exercises the pure helpers in out/deepseekToolBridge.js and verifies
 * tool-calling capability declarations in out/deepseekProvider.js.
 *
 * Run: node scripts/run-deepseek-tool-bridge-tests.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const BRIDGE = path.join(__dirname, '..', 'out', 'deepseekToolBridge.js');
const PROVIDER = path.join(__dirname, '..', 'out', 'deepseekProvider.js');

if (!fs.existsSync(BRIDGE)) {
    console.error(`[tool-bridge] missing ${path.relative(process.cwd(), BRIDGE)} — run "npm run compile" first.`);
    process.exit(1);
}

const {
    toOpenAiTools,
    buildChatMessages,
    ToolCallAccumulator
} = require(BRIDGE);

let failures = 0;
let passed = 0;

function assert(cond, message) {
    if (!cond) throw new Error(message);
}
function assertEqual(actual, expected, label) {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}
function assertDeepEqual(actual, expected, label) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (e) {
        failures++;
        console.log(`  FAIL  ${name}\n        ${e.message}`);
    }
}

/** A control must throw. If it passes, the harness cannot detect a defect. */
function control(name, fn) {
    let fired = false;
    try {
        fn();
    } catch {
        fired = true;
    }
    if (fired) {
        passed++;
        console.log(`  PASS  control fired as required: ${name}`);
    } else {
        failures++;
        console.log(`  FAIL  CONTROL DID NOT FIRE: ${name}\n        A suite that cannot go red proves nothing.`);
    }
}

console.log('\n[deepseek tool bridge] toOpenAiTools');

check('maps name, description and parameters', () => {
    const defs = toOpenAiTools([
        { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }
    ]);
    assertDeepEqual(defs, [{
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } }
        }
    }], 'tool definition');
});

check('returns undefined when there is nothing to advertise', () => {
    assertEqual(toOpenAiTools(undefined), undefined, 'undefined input');
    assertEqual(toOpenAiTools(null), undefined, 'null input');
    assertEqual(toOpenAiTools([]), undefined, 'empty array');
});

check('substitutes an object schema when inputSchema is missing', () => {
    const defs = toOpenAiTools([{ name: 'no_schema' }]);
    assertDeepEqual(defs[0].function.parameters, { type: 'object', properties: {} }, 'default schema');
    assertEqual(defs[0].function.description, '', 'default description');
});

check('drops entries with no usable name', () => {
    const defs = toOpenAiTools([{ name: '' }, { name: '   ' }, {}, { name: 'kept' }]);
    assertEqual(defs.length, 1, 'kept entry count');
    assertEqual(defs[0].function.name, 'kept', 'kept entry name');
});

check('returns undefined when every entry is unusable', () => {
    assertEqual(toOpenAiTools([{ name: '' }]), undefined, 'all-unusable input');
});

console.log('\n[deepseek tool bridge] buildChatMessages');

check('plain user and assistant messages pass through', () => {
    const out = buildChatMessages([
        { role: 'user', parts: [{ kind: 'text', text: 'hello' }] },
        { role: 'assistant', parts: [{ kind: 'text', text: 'hi there' }] }
    ]);
    assertDeepEqual(out, [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' }
    ], 'plain exchange');
});

check('joins multiple text parts with newlines', () => {
    const out = buildChatMessages([
        { role: 'user', parts: [{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }] }
    ]);
    assertEqual(out[0].content, 'a\nb', 'joined text');
});

check('assistant tool call becomes tool_calls with JSON arguments', () => {
    const out = buildChatMessages([
        {
            role: 'assistant',
            parts: [
                { kind: 'text', text: 'let me look' },
                { kind: 'toolCall', callId: 'call_1', name: 'read_file', input: { path: 'a.ts' } }
            ]
        }
    ]);
    assertEqual(out[0].role, 'assistant', 'role');
    assertEqual(out[0].content, 'let me look', 'content preserved alongside call');
    assertEqual(out[0].tool_calls.length, 1, 'tool_calls length');
    assertEqual(out[0].tool_calls[0].id, 'call_1', 'call id');
    assertEqual(out[0].tool_calls[0].type, 'function', 'call type');
    assertEqual(out[0].tool_calls[0].function.name, 'read_file', 'call name');
    assertEqual(out[0].tool_calls[0].function.arguments, '{"path":"a.ts"}', 'serialized arguments');
});

check('assistant tool call with no text sends null content', () => {
    const out = buildChatMessages([
        { role: 'assistant', parts: [{ kind: 'toolCall', callId: 'c', name: 'n', input: {} }] }
    ]);
    assertEqual(out[0].content, null, 'null content for call-only turn');
});

check('tool result becomes a role:tool message carrying tool_call_id', () => {
    const out = buildChatMessages([
        { role: 'user', parts: [{ kind: 'toolResult', callId: 'call_1', text: 'file contents' }] }
    ]);
    assertDeepEqual(out, [
        { role: 'tool', tool_call_id: 'call_1', content: 'file contents' }
    ], 'tool result message');
});

check('tool results are emitted BEFORE remaining user text', () => {
    const out = buildChatMessages([
        {
            role: 'user',
            parts: [
                { kind: 'text', text: 'and also check b.ts' },
                { kind: 'toolResult', callId: 'call_1', text: 'a.ts contents' }
            ]
        }
    ]);
    assertEqual(out.length, 2, 'message count');
    assertEqual(out[0].role, 'tool', 'tool result comes first (required by the API)');
    assertEqual(out[1].role, 'user', 'user text follows');
    assertEqual(out[1].content, 'and also check b.ts', 'user text preserved');
});

check('empty tool result is given a placeholder rather than blank content', () => {
    const out = buildChatMessages([
        { role: 'user', parts: [{ kind: 'toolResult', callId: 'c', text: '   ' }] }
    ]);
    assertEqual(out[0].content, '[tool returned empty result]', 'placeholder content');
});

check('renderText hook can substitute multimodal content', () => {
    const out = buildChatMessages(
        [{ role: 'user', parts: [{ kind: 'text', text: 'what is this' }], media: [{ mimeType: 'image/png', data: 'AAA' }] }],
        (text, message) => [{ type: 'text', text }, { type: 'image_url', count: message.media.length }]
    );
    assertDeepEqual(out[0].content, [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', count: 1 }
    ], 'multimodal content array');
});

check('a full agent turn keeps call/result pairing intact', () => {
    const out = buildChatMessages([
        { role: 'user', parts: [{ kind: 'text', text: 'read a.ts' }] },
        { role: 'assistant', parts: [{ kind: 'toolCall', callId: 'c1', name: 'read_file', input: { path: 'a.ts' } }] },
        { role: 'user', parts: [{ kind: 'toolResult', callId: 'c1', text: 'export const a = 1;' }] }
    ]);
    assertDeepEqual(out.map(m => m.role), ['user', 'assistant', 'tool'], 'turn roles');
    assertEqual(out[1].tool_calls[0].id, out[2].tool_call_id, 'call id matches result id');
});

console.log('\n[deepseek tool bridge] ToolCallAccumulator');

check('reassembles a single call split across fragments', () => {
    const acc = new ToolCallAccumulator();
    acc.push([{ index: 0, id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '' } }]);
    acc.push([{ index: 0, function: { arguments: '{"pa' } }]);
    acc.push([{ index: 0, function: { arguments: 'th":"a.ts"}' } }]);
    const calls = acc.finish();
    assertEqual(calls.length, 1, 'call count');
    assertEqual(calls[0].callId, 'call_abc', 'call id');
    assertEqual(calls[0].name, 'read_file', 'call name');
    assertDeepEqual(calls[0].input, { path: 'a.ts' }, 'parsed arguments');
    assertEqual(calls[0].parseFailed, false, 'parseFailed flag');
});

check('keeps the id even though later fragments omit it', () => {
    const acc = new ToolCallAccumulator();
    acc.push([{ index: 0, id: 'only_here' }]);
    acc.push([{ index: 0, function: { name: 'n', arguments: '{}' } }]);
    assertEqual(acc.finish()[0].callId, 'only_here', 'id retained across fragments');
});

check('keeps parallel calls separate and in index order', () => {
    const acc = new ToolCallAccumulator();
    acc.push([{ index: 1, id: 'b', function: { name: 'second', arguments: '{}' } }]);
    acc.push([{ index: 0, id: 'a', function: { name: 'first', arguments: '{}' } }]);
    const calls = acc.finish();
    assertDeepEqual(calls.map(c => c.name), ['first', 'second'], 'index order');
    assertDeepEqual(calls.map(c => c.callId), ['a', 'b'], 'ids stay with their calls');
});

check('empty argument string yields an empty object, not a parse failure', () => {
    const acc = new ToolCallAccumulator();
    acc.push([{ index: 0, id: 'x', function: { name: 'noargs', arguments: '' } }]);
    const calls = acc.finish();
    assertDeepEqual(calls[0].input, {}, 'empty object');
    assertEqual(calls[0].parseFailed, false, 'not a parse failure');
});

check('malformed argument JSON is flagged instead of silently dropped', () => {
    const acc = new ToolCallAccumulator();
    acc.push([{ index: 0, id: 'x', function: { name: 'bad', arguments: '{"a":' } }]);
    const calls = acc.finish();
    assertEqual(calls.length, 1, 'call still surfaced');
    assertEqual(calls[0].parseFailed, true, 'parseFailed flag set');
    assertDeepEqual(calls[0].input, {}, 'falls back to empty object');
    assertEqual(calls[0].rawArguments, '{"a":', 'raw arguments preserved for diagnosis');
});

check('drops calls with no name — they cannot be invoked', () => {
    const acc = new ToolCallAccumulator();
    acc.push([{ index: 0, id: 'x', function: { arguments: '{}' } }]);
    assertEqual(acc.finish().length, 0, 'nameless call dropped');
});

check('a re-sent name prefix does not duplicate the name', () => {
    const acc = new ToolCallAccumulator();
    acc.push([{ index: 0, id: 'x', function: { name: 'read_file', arguments: '' } }]);
    acc.push([{ index: 0, function: { name: 'read_file', arguments: '{}' } }]);
    assertEqual(acc.finish()[0].name, 'read_file', 'name not duplicated');
});

check('genuinely streamed name fragments are concatenated', () => {
    const acc = new ToolCallAccumulator();
    acc.push([{ index: 0, id: 'x', function: { name: 'read_' } }]);
    acc.push([{ index: 0, function: { name: 'file' } }]);
    assertEqual(acc.finish()[0].name, 'read_file', 'name assembled');
});

check('non-array deltas are ignored without throwing', () => {
    const acc = new ToolCallAccumulator();
    acc.push(undefined);
    acc.push(null);
    acc.push('nope');
    acc.push({ nope: true });
    assertEqual(acc.finish().length, 0, 'nothing assembled');
});

check('size reflects distinct calls seen', () => {
    const acc = new ToolCallAccumulator();
    assertEqual(acc.size, 0, 'empty');
    acc.push([{ index: 0, id: 'a', function: { name: 'x', arguments: '{}' } }]);
    acc.push([{ index: 0, function: { arguments: '' } }]);
    assertEqual(acc.size, 1, 'one distinct call after two fragments');
    acc.push([{ index: 1, id: 'b', function: { name: 'y', arguments: '{}' } }]);
    assertEqual(acc.size, 2, 'second call counted');
});

check('server that omits index entirely still yields ONE call with complete arguments', () => {
    const acc = new ToolCallAccumulator();
    // A server that never sends index splits the argument JSON across chunks. The
    // old behaviour opened a fresh nameless slot per fragment and finish() dropped
    // every slice, so the tool ran with truncated or empty arguments.
    acc.push([{ id: 'call_x', function: { name: 'get_time', arguments: '{"time' } }]);
    acc.push([{ function: { arguments: 'zone":' } }]);
    acc.push([{ function: { arguments: ' "UTC"}' } }]);
    const calls = acc.finish();
    assertEqual(calls.length, 1, 'exactly one call assembled, not one slot per fragment');
    assertEqual(calls[0].name, 'get_time', 'name survives');
    assertEqual(calls[0].rawArguments, '{"timezone": "UTC"}', 'all argument slices concatenated');
    assertDeepEqual(calls[0].input, { timezone: 'UTC' }, 'arguments parse into the real input');
    assertEqual(calls[0].parseFailed, false, 'arguments parsed cleanly');
});

check('two calls that both omit index are still told apart by differing ids', () => {
    const acc = new ToolCallAccumulator();
    acc.push([{ id: 'call_a', function: { name: 'get_time', arguments: '{"timezone":"UTC"}' } }]);
    acc.push([{ id: 'call_b', function: { name: 'add_numbers', arguments: '{"a":2,"b":3}' } }]);
    const calls = acc.finish();
    assertEqual(calls.length, 2, 'two distinct calls, not one merged call');
    assertEqual(calls[0].name, 'get_time', 'first call name preserved');
    assertEqual(calls[1].name, 'add_numbers', 'second call name preserved');
});

console.log('\n[deepseek provider] shipped artifact');

check('all four picker models advertise toolCalling:true', () => {
    assert(fs.existsSync(PROVIDER), 'out/deepseekProvider.js must exist');
    const text = fs.readFileSync(PROVIDER, 'utf8');
    // Match only real capability declarations — `capabilities: { ... toolCalling: X ... }`.
    const trueCount = (text.match(/capabilities:\s*\{[^}]*?toolCalling:\s*true/g) || []).length;
    const falseCount = (text.match(/capabilities:\s*\{[^}]*?toolCalling:\s*false/g) || []).length;
    assertEqual(falseCount, 0, 'capability declarations with toolCalling:false (VS Code hides these models in Agent mode)');
    assertEqual(trueCount, 4, 'capability declarations with toolCalling:true (one per picker model)');
});

check('shipped provider forwards tools and emits tool calls', () => {
    const text = fs.readFileSync(PROVIDER, 'utf8');
    assert(/toOpenAiTools/.test(text), 'tool schema mapping is wired');
    assert(/requestBody\.tools/.test(text), 'tools are added to the request body');
    assert(/LanguageModelToolCallPart/.test(text), 'tool calls are reported back to VS Code');
    assert(/ToolCallAccumulator/.test(text), 'streamed tool calls are reassembled');
});

console.log('\n[negative control]');

control('expecting two tool calls from a one-call stream', () => {
    const acc = new ToolCallAccumulator();
    acc.push([{ index: 0, id: 'only', function: { name: 'solo', arguments: '{}' } }]);
    assertEqual(acc.finish().length, 2, 'deliberately wrong expectation');
});

control('expecting a call id that the stream never contained', () => {
    const acc = new ToolCallAccumulator();
    acc.push([{ index: 0, function: { name: 'n', arguments: '{}' } }]);
    assertEqual(acc.finish()[0].callId, 'call_that_never_existed', 'deliberately wrong expectation');
});

control('expecting toolCalling:false to be absent from a synthetic bad artifact', () => {
    const synthetic = 'capabilities: { toolCalling: false }';
    const falseCount = (synthetic.match(/capabilities:\s*\{[^}]*?toolCalling:\s*false/g) || []).length;
    assertEqual(falseCount, 0, 'deliberately wrong expectation');
});

control('a comment mentioning toolCalling:false must NOT count as a declaration', () => {
    const synthetic = '// old note: this used toolCalling:false\ncapabilities: { toolCalling: true }';
    assertEqual(
        (synthetic.match(/capabilities:\s*\{[^}]*?toolCalling:\s*false/g) || []).length,
        1,
        'deliberately wrong expectation — only a real declaration may count'
    );
});

const total = passed + failures;
console.log(`\n[tool-bridge] ${passed}/${total} passed, ${failures} failed\n`);
if (failures > 0) {
    process.exit(1);
}
