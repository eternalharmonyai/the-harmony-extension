#!/usr/bin/env node
/**
 * check:audit-scope — proves a tool call only marks a file as TOUCHED if it can write.
 *
 * Background: the scope builder used to collect any tool call whose input carried a
 * path key. `call.name` was checked for existence and never compared to anything, so
 * READING src/foo.ts put src/foo.ts into the Triple-Check audit scope and into the
 * continuity ledger as an edit. A verified reproduction:
 *
 *   tools : harmony_read_file, harmony_list_dir, harmony_write_file, harmony_grep
 *   scope : ["src/foo.ts", "src", "src/bar.ts"]     <- two of three never written
 *
 * This gate pins both directions, because either one alone is a lie:
 *   - a KNOWN read-only tool must NOT contribute a path
 *   - an UNKNOWN tool MUST contribute a path (a missed change is worse than a
 *     reviewed unchanged file — the failure direction is deliberate)
 *
 * The final control fails the suite if the read/write distinction is removed again.
 */

const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const scopeModule = require(path.join(root, 'out', 'auditScope.js'));

const {
    classifyToolCallReferences,
    formatScopeNote,
    isReadOnlyTool,
    isKnownWriteTool,
    READ_ONLY_TOOL_NAMES,
    KNOWN_WRITE_TOOL_NAMES,
    PATH_INPUT_KEYS,
} = scopeModule;

const checks = [];
let failures = 0;

function check(name, fn) {
    try {
        fn();
        checks.push({ name, ok: true });
    } catch (err) {
        checks.push({ name, ok: false, error: err && err.message ? err.message : String(err) });
        failures += 1;
    }
}

const call = (name, input) => ({ name, input });

// ── 1. Positive control: the surface under test exists ────────────────────────
check('CONTROL: classifier, predicates, sets and note formatter are exported', () => {
    assert.strictEqual(typeof classifyToolCallReferences, 'function', 'classifyToolCallReferences missing');
    assert.strictEqual(typeof formatScopeNote, 'function', 'formatScopeNote missing');
    assert.strictEqual(typeof isReadOnlyTool, 'function', 'isReadOnlyTool missing');
    assert.strictEqual(typeof isKnownWriteTool, 'function', 'isKnownWriteTool missing');
    assert.ok(READ_ONLY_TOOL_NAMES instanceof Set && READ_ONLY_TOOL_NAMES.size > 5, 'read-only set missing');
    assert.ok(KNOWN_WRITE_TOOL_NAMES instanceof Set && KNOWN_WRITE_TOOL_NAMES.size > 5, 'write set missing');
    assert.ok(Array.isArray([...PATH_INPUT_KEYS]) && PATH_INPUT_KEYS.length === 3, 'path keys missing');
});

// ── 2. Negative control: nothing in, nothing out ─────────────────────────────
check('CONTROL: empty and malformed input classify to an empty scope', () => {
    for (const input of [[], undefined, null, 42, 'nope', {}]) {
        const s = classifyToolCallReferences(input);
        assert.deepStrictEqual(s.paths, [], 'paths must be empty');
        assert.deepStrictEqual(s.readOnlyExcluded, []);
        assert.deepStrictEqual(s.unknownTools, []);
    }
});

// ── 3. The defect itself: a read must not mark a file as touched ─────────────
check('a read-only tool contributes NO path — and the exclusion is COUNTED', () => {
    const s = classifyToolCallReferences([call('harmony_read_file', { path: 'src/foo.ts' })]);
    assert.deepStrictEqual(s.paths, [], 'a read must not enter the audit scope');
    assert.deepStrictEqual(s.readOnlyExcluded, ['src/foo.ts'], 'the exclusion must be reported, never silent');
    assert.ok(formatScopeNote(s).includes('read-only'), 'the disclosure must name the exclusion');
});

check('the verified reproduction now yields only the written file', () => {
    const s = classifyToolCallReferences([
        call('harmony_read_file', { path: 'src/foo.ts' }),
        call('harmony_list_dir', { path: 'src' }),
        call('harmony_write_file', { path: 'src/bar.ts' }),
        call('harmony_grep', {}),
    ]);
    assert.deepStrictEqual(s.paths, ['src/bar.ts'], 'only the written file may survive');
    assert.deepStrictEqual(s.readOnlyExcluded.sort(), ['src', 'src/foo.ts'], 'both reads must be disclosed');
});

// ── 4. Real writers must still be caught ────────────────────────────────────
check('write-capable tools are INCLUDED', () => {
    for (const name of ['harmony_write_file', 'harmony_edit_file', 'harmony_apply_patch', 'harmony_rename_symbol']) {
        const s = classifyToolCallReferences([call(name, { path: 'src/x.ts' })]);
        assert.deepStrictEqual(s.paths, ['src/x.ts'], `${name} must count as a change`);
        assert.deepStrictEqual(s.readOnlyExcluded, [], `${name} must not be reported as an exclusion`);
    }
});

check('conditional tools are NOT read-only, whatever their default', () => {
    for (const name of ['harmony_code_actions', 'harmony_canvas_project']) {
        assert.strictEqual(isReadOnlyTool(name), false, `${name} can write, so it is not read-only`);
        assert.deepStrictEqual(classifyToolCallReferences([call(name, { path: 'src/y.ts' })]).paths, ['src/y.ts']);
    }
});

check('mutating git tools are NOT read-only', () => {
    for (const name of ['harmony_git_restore', 'harmony_git_commit', 'harmony_git_revert', 'harmony_git_stash']) {
        assert.strictEqual(isReadOnlyTool(name), false, `${name} mutates state`);
    }
    for (const name of ['harmony_git_diff', 'harmony_git_show', 'harmony_git_log', 'harmony_git_status']) {
        assert.strictEqual(isReadOnlyTool(name), true, `${name} only reads`);
    }
});

// ── 5. THE SAFETY DIRECTION: unknown tools are included, never dropped ──────
check('an UNKNOWN tool is INCLUDED and disclosed — a missed change is worse', () => {
    const s = classifyToolCallReferences([call('some_future_writer_v2', { path: 'src/new.ts' })]);
    assert.deepStrictEqual(s.paths, ['src/new.ts'], 'an unrecognised tool must never be silently excluded');
    assert.deepStrictEqual(s.unknownTools, ['some_future_writer_v2'], 'the unknown tool must be disclosed');
    assert.ok(formatScopeNote(s).includes('unrecognised'), 'the disclosure must name the unknown tool');
});

check('a tool added in neither set is still included', () => {
    const s = classifyToolCallReferences([call('harmony_brand_new_tool', { path: 'src/z.ts' })]);
    assert.deepStrictEqual(s.paths, ['src/z.ts']);
});

// ── 6. Path keys, duplicates, and read+write collisions ─────────────────────
check('path, file_path and filePath are all recognised', () => {
    const s = classifyToolCallReferences([
        call('harmony_write_file', { path: 'a.ts' }),
        call('harmony_write_file', { file_path: 'b.ts' }),
        call('harmony_write_file', { filePath: 'c.ts' }),
    ]);
    assert.deepStrictEqual(s.paths.sort(), ['a.ts', 'b.ts', 'c.ts']);
});

check('duplicate paths collapse to one entry', () => {
    const s = classifyToolCallReferences([
        call('harmony_edit_file', { path: 'a.ts' }),
        call('harmony_write_file', { path: 'a.ts' }),
    ]);
    assert.deepStrictEqual(s.paths, ['a.ts']);
});

check('a file read AND written counts as changed, not as an exclusion', () => {
    const s = classifyToolCallReferences([
        call('harmony_read_file', { path: 'src/both.ts' }),
        call('harmony_edit_file', { path: 'src/both.ts' }),
    ]);
    assert.deepStrictEqual(s.paths, ['src/both.ts'], 'the write wins');
    assert.deepStrictEqual(s.readOnlyExcluded, [], 'a written file must not be advertised as excluded');
});

check('non-string, empty and whitespace path values are ignored', () => {
    const s = classifyToolCallReferences([
        call('harmony_write_file', { path: '' }),
        call('harmony_write_file', { path: '   ' }),
        call('harmony_write_file', { path: 42 }),
        call('harmony_write_file', {}),
    ]);
    assert.deepStrictEqual(s.paths, []);
});

check('calls without a usable name are ignored', () => {
    const s = classifyToolCallReferences([
        { input: { path: 'src/anonymous.ts' } },
        { name: '   ', input: { path: 'src/blank.ts' } },
        { name: 7, input: { path: 'src/numeric.ts' } },
    ]);
    assert.deepStrictEqual(s.paths, []);
});

// ── 7. Bounds and disclosure ────────────────────────────────────────────────
check('maxPaths is honoured and clamped', () => {
    const many = Array.from({ length: 50 }, (_, i) => call('harmony_write_file', { path: `f${i}.ts` }));
    assert.strictEqual(classifyToolCallReferences(many).paths.length, 30, 'default cap is 30');
    assert.strictEqual(classifyToolCallReferences(many, { maxPaths: 5 }).paths.length, 5);
    assert.strictEqual(classifyToolCallReferences(many, { maxPaths: 100000 }).paths.length, 50, 'cap clamps, input is 50');
});

check('formatScopeNote is empty when nothing needed filtering', () => {
    const s = classifyToolCallReferences([call('harmony_write_file', { path: 'a.ts' })]);
    assert.strictEqual(formatScopeNote(s), '', 'no exclusion and no unknown tool means no note');
});

// ── 8. Set hygiene and explicit anti-regression control ─────────────────────
check('CONTROL: no tool is both read-only and known-write', () => {
    for (const name of READ_ONLY_TOOL_NAMES) {
        assert.strictEqual(KNOWN_WRITE_TOOL_NAMES.has(name), false, `${name} is in both sets`);
    }
});

check('CONTROL: folding reads back into the scope would fail this suite', () => {
    const s = classifyToolCallReferences([
        call('harmony_read_file', { path: 'src/read-only.ts' }),
        call('harmony_git_diff', { path: 'src/diff-only.ts' }),
        call('harmony_canvas_inspect', { path: 'media/x.png' }),
    ]);
    assert.deepStrictEqual(s.paths, [], 'read-only references leaked into the scope — the old behaviour is back');
    assert.strictEqual(s.readOnlyExcluded.length, 3, 'the exclusions must be counted');
});

const passed = checks.length - failures;
for (const c of checks) {
    if (c.ok) {
        console.log(`PASS  ${c.name}`);
    } else {
        console.log(`FAIL  ${c.name}\n        ${c.error}`);
    }
}

console.log(`\ncheck-audit-scope: ${passed}/${checks.length} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
