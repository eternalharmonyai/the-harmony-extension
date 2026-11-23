#!/usr/bin/env node
/**
 * check:resilience-circuit — proves the circuit breaker is real, exercised, and honest.
 *
 * Background: the breaker shipped BUILT BUT DORMANT. Nothing called it, which meant
 * circuitStatus() could never be checked and safety code that is never exercised is
 * indistinguishable from safety code that does not work.
 *
 * The danger this gate exists to prevent is the asymmetric wiring bug: recording
 * failures WITHOUT recording successes. That makes a provider permanently report
 * "paused" after five failures — a silent lie on a user-visible surface. So this gate
 * proves both directions, and proves the wiring in the caller does both too.
 */

const path = require('path');
const assert = require('assert');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const resilience = require(path.join(root, 'out', 'resilience.js'));

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

const THRESHOLD = resilience.CIRCUIT_BREAKER_THRESHOLD;
const COOLDOWN = resilience.CIRCUIT_BREAKER_COOLDOWN_MS;
const PROVIDER = 'gate-provider-a';

// ── 1. Positive control: the breaker API exists and a single failure registers ───
check('CONTROL: a single failure is visible in the status line', () => {
  resilience.resetCircuitBreakers();
  resilience.recordFailure(PROVIDER, new Error('ECONNRESET'));
  const status = resilience.circuitStatus(PROVIDER);
  assert.ok(/^1\//.test(status), `expected "1/N", got "${status}"`);
});

check('CONTROL: constants are sane', () => {
  assert.ok(THRESHOLD >= 2, `threshold too low: ${THRESHOLD}`);
  assert.ok(COOLDOWN > 0, `cooldown not positive: ${COOLDOWN}`);
});

// ── 2. Direction one: failures must OPEN the breaker ───────────────────────────
check('breaker stays closed below the threshold', () => {
  resilience.resetCircuitBreakers();
  for (let i = 0; i < THRESHOLD - 1; i += 1) {
    resilience.recordFailure(PROVIDER, new Error('ECONNRESET'));
    assert.strictEqual(resilience.isCircuitOpen(PROVIDER), false,
      `opened early, after ${i + 1} of ${THRESHOLD}`);
  }
});

check('breaker OPENs exactly at the threshold', () => {
  resilience.resetCircuitBreakers();
  for (let i = 0; i < THRESHOLD; i += 1) {
    resilience.recordFailure(PROVIDER, new Error('ECONNRESET'));
  }
  assert.strictEqual(resilience.isCircuitOpen(PROVIDER), true, 'did not open at the threshold');
  assert.ok(/^paused /.test(resilience.circuitStatus(PROVIDER)),
    `status should read "paused ...", got "${resilience.circuitStatus(PROVIDER)}"`);
});

// ── 3. Direction two: a success must CLOSE it (the anti-silent-lie assertion) ────
check('a success CLOSES the breaker and resets the status', () => {
  resilience.resetCircuitBreakers();
  for (let i = 0; i < THRESHOLD; i += 1) {
    resilience.recordFailure(PROVIDER, new Error('ECONNRESET'));
  }
  assert.strictEqual(resilience.isCircuitOpen(PROVIDER), true, 'precondition: should be open');
  resilience.recordSuccess(PROVIDER);
  assert.strictEqual(resilience.isCircuitOpen(PROVIDER), false, 'success did not close the breaker');
  assert.strictEqual(resilience.circuitStatus(PROVIDER), 'healthy', 'status did not return to healthy');
});

// ── 4. Self-healing: the cooldown must allow a probe, never latch forever ───────
check('breaker self-heals after the cooldown instead of latching', () => {
  resilience.resetCircuitBreakers();
  const now = 1_000_000;
  for (let i = 0; i < THRESHOLD; i += 1) {
    resilience.recordFailure(PROVIDER, new Error('ECONNRESET'), now);
  }
  assert.strictEqual(resilience.isCircuitOpen(PROVIDER, now + 1), true, 'not open inside the cooldown');
  assert.strictEqual(resilience.isCircuitOpen(PROVIDER, now + COOLDOWN + 1), false,
    'still open after the cooldown — the breaker latched permanently');
});

// ── 5. Isolation and negative control ───────────────────────────────────────────
check('providers do not share a breaker', () => {
  resilience.resetCircuitBreakers();
  for (let i = 0; i < THRESHOLD; i += 1) {
    resilience.recordFailure('gate-provider-b', new Error('ECONNRESET'));
  }
  assert.strictEqual(resilience.isCircuitOpen('gate-provider-b'), true, 'b did not open');
  assert.strictEqual(resilience.isCircuitOpen('gate-provider-c'), false, 'c was affected by b');
  assert.strictEqual(resilience.circuitStatus('gate-provider-never-seen'), 'healthy',
    'an untouched provider is not healthy');
});

// ── 6. Ensure the backoff floor still holds (the original ECONNRESET fix) ───────
check('backoff keeps a guaranteed floor instead of full jitter', () => {
  const lowest = resilience.backoffDelayMs(1, { random: () => 0, baseMs: 2000, capMs: 15000 });
  assert.strictEqual(lowest, 1000, `equal jitter floor broken: expected 1000ms, got ${lowest}`);
  const highest = resilience.backoffDelayMs(1, { random: () => 1, baseMs: 2000, capMs: 15000 });
  assert.ok(highest <= 2000, `first retry exceeded base: ${highest}`);
});

// ── 7. The CALLER must wire both directions, not just one ──────────────────────
check('chat loop records failures', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'chatParticipant.ts'), 'utf8');
  assert.ok(/recordFailure\(route\.provider/.test(src), 'chatParticipant never records a failure');
});

check('chat loop records successes (the anti-silent-lie wiring)', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'chatParticipant.ts'), 'utf8');
  assert.ok(/recordSuccess\(route\.provider/.test(src), 'chatParticipant never records a success');
});

check('chat loop actually consults the breaker', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'chatParticipant.ts'), 'utf8');
  assert.ok(/isCircuitOpen\(route\.provider/.test(src), 'chatParticipant never checks the breaker');
});

check('non-transient errors are excluded from health accounting', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'chatParticipant.ts'), 'utf8');
  assert.ok(/if \(classifyTransient\(e\)\.transient\)/.test(src),
    'the exhaustion path records failures without a transient guard');
  const verdict = resilience.classifyTransient(new Error('HTTP 400 invalid request payload'));
  assert.strictEqual(verdict.transient, false, 'a request-shaped 400 was classified as transient');
});

resilience.resetCircuitBreakers();

const lines = checks.map(c => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n        ${c.error}`}`);
console.log(lines.join('\n'));

if (failures > 0) {
  console.error(`\ncheck-resilience-circuit: ${checks.length - failures}/${checks.length} passed, ${failures} FAILED`);
  process.exit(1);
}
console.log(`\ncheck-resilience-circuit: ${checks.length}/${checks.length} passed, 0 failed`);
