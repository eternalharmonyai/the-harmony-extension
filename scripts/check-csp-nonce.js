#!/usr/bin/env node
/**
 * check:csp-nonce — proves inline script is gated by a nonce, not by 'unsafe-inline'.
 *
 * Why this matters:
 * The chat body escapes model output before rendering it, so there is no exploitable
 * XSS today. But that safety rests entirely on the escaping being correct forever.
 * A nonce-based CSP converts that from a trusted invariant into one the browser
 * enforces: an injected inline script has no valid nonce, so it cannot run.
 *
 * Same discipline as the other gates here: every negative assertion is paired with a
 * positive control, so the gate cannot pass because the renderer quietly broke.
 */

const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const server = require(path.join(root, 'out', 'host', 'standaloneServer.js'));

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

/** Pull one CSP directive out of a policy string. */
function directive(policy, name) {
  const part = String(policy).split(';').map(s => s.trim()).find(s => s.startsWith(name + ' '));
  return part || '';
}

// ── 1. Builders exist (positive control for everything below) ────────────────────
check('CONTROL: both CSP builders are exported', () => {
  assert.strictEqual(typeof server.buildStandaloneCsp, 'function', 'buildStandaloneCsp missing');
  assert.strictEqual(typeof server.buildDevCsp, 'function', 'buildDevCsp missing');
});

const NONCE = 'dGVzdC1ub25jZS12YWx1ZQ==';
const csp = server.buildStandaloneCsp(NONCE);

check('CONTROL: policy is a non-trivial string', () => {
  assert.ok(typeof csp === 'string' && csp.length > 120, 'policy suspiciously short');
  assert.ok(csp.includes('default-src'), 'policy has no default-src');
});

// ── 2. script-src uses the nonce and NOT unsafe-inline ──────────────────────────
check('script-src carries the per-request nonce', () => {
  const scriptSrc = directive(csp, 'script-src');
  assert.ok(scriptSrc.includes(`'nonce-${NONCE}'`), `script-src missing nonce: ${scriptSrc}`);
});

check('script-src does NOT allow unsafe-inline', () => {
  const scriptSrc = directive(csp, 'script-src');
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), `script-src still allows inline: ${scriptSrc}`);
});

// ── 3. The documented residual must stay documented, not accidental ─────────────
check('style-src still allows inline (known residual, deliberate)', () => {
  const styleSrc = directive(csp, 'style-src');
  assert.ok(styleSrc.includes("'unsafe-inline'"), `style-src lost inline: ${styleSrc}`);
});

check('dangerous surfaces stay off', () => {
  assert.ok(csp.includes("frame-src 'none'"), 'frame-src is not none');
  assert.ok(csp.includes("object-src 'none'"), 'object-src is not none');
});

// ── 4. Nonces must differ per request ───────────────────────────────────────────
check('two nonces produce two different policies', () => {
  const a = server.buildStandaloneCsp('nonce-a');
  const b = server.buildStandaloneCsp('nonce-b');
  assert.notStrictEqual(a, b, 'policy is not nonce-dependent — it is effectively static');
});

// ── 5. Dev policy is stricter ───────────────────────────────────────────────────
check('dev policy is default-deny and nonce-gated', () => {
  const devCsp = server.buildDevCsp(NONCE);
  assert.ok(devCsp.includes("default-src 'none'"), 'dev policy is not default-deny');
  const scriptSrc = directive(devCsp, 'script-src');
  assert.ok(scriptSrc.includes(`'nonce-${NONCE}'`), 'dev script-src missing nonce');
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), 'dev script-src still allows inline');
});

// ── 6. The rendered page: every script tag must carry the nonce ─────────────────
check('CONTROL: main page renders with script content intact', () => {
  const html = server.renderStandaloneDesktopHtml(root, 201, 'tok', NONCE);
  assert.ok(html.length > 20000, 'rendered page suspiciously small');
  assert.ok(html.includes('const SESSION_TOKEN'), 'the app script content is missing');
  assert.ok(html.includes(`nonce="${NONCE}"`), 'the nonce was not emitted');
});

check('main page has no script tag without a nonce', () => {
  const html = server.renderStandaloneDesktopHtml(root, 201, 'tok', NONCE);
  const all = (html.match(/<script/gi) || []).length;
  const gated = (html.match(/<script[^>]*\snonce="/gi) || []).length;
  assert.ok(all > 0, 'no script tags found — the check would be vacuous');
  assert.strictEqual(gated, all, `${all - gated} of ${all} script tags have no nonce`);
});

check('dev page has no script tag without a nonce', () => {
  const html = server.renderDevSurfaceHtml({
    authorized: false,
    tokenPresent: false,
    tokenDisplayPath: '%LOCALAPPDATA%\\Harmony\\dev-token',
    toolCount: 201,
    nonce: NONCE,
  });
  const all = (html.match(/<script/gi) || []).length;
  const gated = (html.match(/<script[^>]*\snonce="/gi) || []).length;
  assert.ok(all > 0, 'no script tags found on the dev page — the check would be vacuous');
  assert.strictEqual(gated, all, `${all - gated} of ${all} dev script tags have no nonce`);
});

// ── 7. Escaping invariant is still intact (the primary control) ─────────────────
check('chat body still escapes markup before rendering', () => {
  const html = server.renderStandaloneDesktopHtml(root, 201, 'tok', NONCE);
  assert.ok(html.includes('function escapeHtmlText'), 'the escaping helper disappeared');
  const escapesEntity = html.includes(".replace(/&/g, '&amp;')");
  assert.ok(escapesEntity, 'the & escaping step is missing');
  const escapesLt = html.includes(".replace(/</g, '&lt;')");
  assert.ok(escapesLt, 'the < escaping step is missing');
});

const lines = checks.map(c => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `\n        ${c.error}`}`);
console.log(lines.join('\n'));

if (failures > 0) {
  console.error(`\ncheck-csp-nonce: ${checks.length - failures}/${checks.length} passed, ${failures} FAILED`);
  process.exit(1);
}
console.log(`\ncheck-csp-nonce: ${checks.length}/${checks.length} passed, 0 failed`);
