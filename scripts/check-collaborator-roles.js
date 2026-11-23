#!/usr/bin/env node
/**
 * Gate: Collaborator role taxonomy + intent selection.
 *
 * Loads the REAL compiled module (out/collaboratorRoles.js) rather than a
 * hand-mirrored copy, so this gate cannot pass while the shipped code drifts.
 *
 * Run: npm run check:collaborator-roles
 */
'use strict';

const path = require('path');
const mod = require(path.join(__dirname, '..', 'out', 'collaboratorRoles.js'));

const {
    COLLABORATOR_ROLES,
    COLLABORATOR_ROLE_TIERS,
    COLLABORATOR_ROLE_LABELS,
    SWARM_ROLE_TO_COLLABORATOR,
    AMBIGUITY_THRESHOLD,
    selectCollaboratorRole,
    normalizeSwarmRole,
    isCollaboratorRole,
} = mod;

let pass = 0;
const failures = [];

function check(name, condition, detail) {
    if (condition) {
        pass++;
    } else {
        failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    }
}

function expectRole(task, expected, options) {
    const opts = options || {};
    const sel = selectCollaboratorRole(task);
    const okRole = opts.ambiguous === undefined
        ? sel.role === expected
        : sel.role === expected && sel.ambiguous === opts.ambiguous;
    check(
        `role("${task}")`,
        okRole,
        `expected ${expected}${opts.ambiguous === undefined ? '' : ` (ambiguous=${opts.ambiguous})`}, got ${sel.role} (confidence ${sel.confidence}, ambiguous=${sel.ambiguous}) [${sel.matched.join(', ')}]`
    );
    // Every selection must carry a non-empty, human-readable rationale.
    check(`reason("${task}")`, typeof sel.reason === 'string' && sel.reason.length > 10, 'reason missing or too short');
    return sel;
}

// ── 1. Canonical taxonomy ─────────────────────────────────────────────────
check('exactly 8 canonical roles', COLLABORATOR_ROLES.length === 8, `got ${COLLABORATOR_ROLES.length}`);
check('no duplicate roles', new Set(COLLABORATOR_ROLES).size === 8);
check('every role has a tier', COLLABORATOR_ROLES.every((r) => !!COLLABORATOR_ROLE_TIERS[r]));
check('every role has a label', COLLABORATOR_ROLES.every((r) => !!COLLABORATOR_ROLE_LABELS[r]));
check('implementer is coding tier', COLLABORATOR_ROLE_TIERS.implementer === 'coding');
check('hard_reasoner is heavy tier', COLLABORATOR_ROLE_TIERS.hard_reasoner === 'heavy');

// ── 2. Swarm vocabulary mapping (old IDs stay valid) ──────────────────────
check('project_scout maps to scout', normalizeSwarmRole('project_scout') === 'scout');
check('designer maps to implementer', normalizeSwarmRole('designer') === 'implementer');
check('coordinator maps to conductor, not a Collaborator', normalizeSwarmRole('coordinator') === 'conductor');
check('canonical pass-through', normalizeSwarmRole('critic') === 'critic');
check('unknown id returns undefined', normalizeSwarmRole('not_a_role') === undefined);
check('empty id returns undefined', normalizeSwarmRole('') === undefined);
check('every swarm collaborator id resolves', ['project_scout', 'researcher', 'designer', 'implementer', 'verifier', 'cost_sentinel']
    .every((id) => isCollaboratorRole(normalizeSwarmRole(id))));
check('SWARM_ROLE_TO_COLLABORATOR covers all 7 swarm ids', Object.keys(SWARM_ROLE_TO_COLLABORATOR).length === 7);

// ── 3. Intent selection: the real point of the module ─────────────────────
expectRole('Find where the auth token is refreshed', 'scout');
expectRole('locate the retry logic in providers.ts', 'scout');
expectRole('which files reference harmonyspawnworker', 'scout');

expectRole('review this patch for security risks', 'critic');
expectRole('what could go wrong with this migration', 'critic');
expectRole('give me a second opinion on this design', 'critic');

expectRole('verify the fix does not regress existing tests', 'verifier');
expectRole('does this still work after the change', 'verifier');

expectRole('plan the rollout in phases with dependencies', 'planner');
expectRole('give me a roadmap for the migration', 'planner');

expectRole('how much will this cost in tokens', 'cost_sentinel');
expectRole('assess provider risk and budget for this', 'cost_sentinel');

expectRole('implement the retry backoff in providers.ts', 'implementer');
expectRole('refactor the session parser', 'implementer');

expectRole('research the evidence for this claim', 'researcher');

expectRole('resolve this paradox in the policy gate', 'hard_reasoner');

// ── 4. False-positive resistance (lesson from the security-plane defect) ──
// A single weak word must never produce a confident verdict.
const weak = selectCollaboratorRole('replace the test fixture with the new format');
check('weak single signal is flagged ambiguous', weak.ambiguous === true, `confidence ${weak.confidence}`);
check('ambiguous result still reports a best guess', isCollaboratorRole(weak.role));

// Pure implementation language must not be hijacked by incidental nouns.
const impl = selectCollaboratorRole('add a small helper function to format dates');
check('plain implementation language selects implementer', impl.role === 'implementer', `got ${impl.role}`);

// Empty / whitespace input must not crash or claim certainty.
const empty = selectCollaboratorRole('');
check('empty task does not crash', empty.role === 'implementer' && empty.ambiguous === true);
check('empty task has zero confidence', empty.confidence === 0);

const noSignal = selectCollaboratorRole('hello there');
check('no-signal task is ambiguous', noSignal.ambiguous === true);
check('no-signal confidence below threshold', noSignal.confidence < AMBIGUITY_THRESHOLD);

// ── 5. Shape guarantees every call site relies on ─────────────────────────
['find the file', 'review the risks', '', 'hello'].forEach((task) => {
    const s = selectCollaboratorRole(task);
    check(`shape("${task}")`, isCollaboratorRole(s.role)
        && typeof s.confidence === 'number'
        && s.confidence >= 0 && s.confidence <= 100
        && Array.isArray(s.matched)
        && Array.isArray(s.alternatives)
        && typeof s.ambiguous === 'boolean');
});

// ── Report ────────────────────────────────────────────────────────────────
const total = pass + failures.length;
if (failures.length === 0) {
    console.log(`✅ check:collaborator-roles — ${pass}/${total} assertions passed`);
    process.exit(0);
}
console.error(`❌ check:collaborator-roles — ${failures.length} of ${total} failed:\n`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);
