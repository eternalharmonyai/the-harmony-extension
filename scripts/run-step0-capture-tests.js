#!/usr/bin/env node
/**
 * Request-side step telemetry capture tests plus negative control.
 *
 * Four unit tests against the pure helper in out/stepCapture.js, plus a
 * negative control that drops `stepOutcome` and verifies the completeness check fails.
 *
 * Run: node scripts/run-step0-capture-tests.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'out', 'stepCapture.js');
if (!fs.existsSync(OUT)) {
    console.error(`[step-capture] missing ${path.relative(process.cwd(), OUT)} — run "npm run compile" first.`);
    process.exit(1);
}

const {
    captureStepFields,
    captureStepFieldsWithoutOutcome,
    STEP_CAPTURE_FIELDS,
    PROMPT_ESTIMATOR_VERSION
} = require(OUT);

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

/** Every field the completeness check insists on. */
function assertComplete(fields) {
    for (const key of STEP_CAPTURE_FIELDS) {
        assert(
            Object.prototype.hasOwnProperty.call(fields, key),
            `missing captured field: ${key}`
        );
        assert(fields[key] !== undefined, `captured field is undefined: ${key}`);
    }
}

const base = {
    provider: 'deepseek',
    tier: 'heavy',
    model: 'deepseek-reasoner',
    promptChars: 1000,
    promptCjkChars: 200,
    toolSchemaChars: 19600,
    toolCount: 191,
    turnId: 'turn-abc',
    stepIndex: 0,
    isDeepSeek: true,
    stepOutcome: 'completed'
};

console.log('[step-capture] capture helper tests');

check('T1 completed capture carries every required field, stepId is 1-based', () => {
    const f = captureStepFields(base);
    assertComplete(f);
    assertEqual(f.stepId, 1, 'stepId');
    assertEqual(f.stepOutcome, 'completed', 'stepOutcome');
    assertEqual(f.turnId, 'turn-abc', 'turnId');
});

check('T2 a failed step records the same request facts; only outcome and step differ', () => {
    const ok = captureStepFields(base);
    const bad = captureStepFields({ ...base, stepOutcome: 'failed', stepIndex: 2 });
    assertEqual(bad.stepOutcome, 'failed', 'stepOutcome');
    assertEqual(bad.stepId, 3, 'stepId');
    for (const key of STEP_CAPTURE_FIELDS) {
        if (key === 'stepOutcome' || key === 'stepId') continue;
        assertDeepEqual(bad[key], ok[key], `field ${key} changed with the outcome`);
    }
});

check('T3 estimatorVersion is pinned on DeepSeek and "none" elsewhere', () => {
    assertEqual(captureStepFields(base).estimatorVersion, PROMPT_ESTIMATOR_VERSION, 'DeepSeek stamp');
    const other = captureStepFields({ ...base, provider: 'gemini', isDeepSeek: false });
    assertEqual(other.estimatorVersion, 'none', 'non-DeepSeek stamp');
});

check('T4 the captured key set is exactly STEP_CAPTURE_FIELDS, for both outcomes', () => {
    const expected = [...STEP_CAPTURE_FIELDS].sort();
    for (const outcome of ['completed', 'failed']) {
        const keys = Object.keys(captureStepFields({ ...base, stepOutcome: outcome })).sort();
        assertDeepEqual(keys, expected, `${outcome} key set`);
    }
});

// ── Verify that omitting `stepOutcome` fails the completeness check. ──
console.log('[step-capture] completeness check: drop stepOutcome, T1 must FAIL');
let controlCaught = false;
try {
    assertComplete(captureStepFieldsWithoutOutcome(base));
} catch (e) {
    controlCaught = true;
    console.log(`  PASS  control caught the mutation (${e.message})`);
}
if (!controlCaught) {
    failures++;
    console.log('  FAIL  control NOT caught — T1 would pass without stepOutcome, so it proves nothing');
}

console.log(`\n[step-capture] ${passed}/${passed + failures} checks passed; failures=${failures}`);
if (failures > 0) {
    console.error('[step-capture] FAILED');
    process.exit(1);
}
console.log('[step-capture] PASS');
