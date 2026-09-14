#!/usr/bin/env node
'use strict';
/**
 * Guard: every Hub call must go through the authenticated hubClient.
 *
 * Why this exists: the daemon gates ALL routes (including /status) behind a
 * Bearer token. When that gating was added, nine probes still used a bare
 * `fetch` and silently misread a healthy Hub as "offline". This check fails the
 * build if a Hub call bypasses hubClient, so the next auth change cannot repeat
 * that failure silently.
 *
 * Rule: in src/**, a bare `fetch(` whose first argument resolves to the Hub
 * (a variable derived from `hub.url`, or a literal :7878) must instead be the
 * authenticated `hubFetch(` exported by ./hubClient. hubClient.ts is the
 * wrapper itself and is exempt.
 *
 * Resolution is scope-aware: a variable is judged by its NEAREST PRECEDING
 * assignment, so a local name that shadows a Hub variable (e.g. a provider or
 * GitHub URL also called `url`) is not a false positive.
 *
 * Usage:  node scripts/check-hub-auth.js [--self-test]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const EXEMPT = new Set(['hubClient.ts']);
const HUB_SIGNAL = /hub\.url|hubBaseUrl\s*\(|127\.0\.0\.1:7878|:7878/;
const BARE_FETCH = /(?<![\w$.])fetch\s*\(/g;

function listFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (e.isFile() && p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** All `const|let|var name = rhs;` assignments, in source order. */
function assignments(text) {
  const list = [];
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  let m;
  while ((m = re.exec(text))) list.push({ name: m[1], rhs: m[2], index: m.index });
  return list;
}

/** Nearest assignment to `name` that appears before `beforeIndex`. */
function nearestAssignment(list, name, beforeIndex) {
  let best = null;
  for (const a of list) {
    if (a.name === name && a.index < beforeIndex) best = a;
  }
  return best;
}

/** Does `expr` resolve to the Hub, following nearest-preceding assignments? */
function resolvesToHub(expr, list, beforeIndex, depth = 0) {
  if (depth > 6) return false;
  if (HUB_SIGNAL.test(expr)) return true;
  const names = expr.match(/[A-Za-z_$][\w$]*/g) || [];
  for (const n of names) {
    const a = nearestAssignment(list, n, beforeIndex);
    if (a && resolvesToHub(a.rhs, list, a.index, depth + 1)) return true;
  }
  return false;
}

/** First argument expression of a `fetch(` call whose '(' is at index `open`. */
function firstArg(text, open) {
  let depth = 1;
  let i = open + 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') { if (--depth === 0) break; }
    else if (c === ',' && depth === 1) break;
  }
  return text.slice(open + 1, i);
}

/** Bare `fetch(` calls in `text` whose target resolves to the Hub. */
function scan(text) {
  const list = assignments(text);
  const hits = [];
  let m;
  BARE_FETCH.lastIndex = 0;
  while ((m = BARE_FETCH.exec(text))) {
    const arg = firstArg(text, text.indexOf('(', m.index));
    if (resolvesToHub(arg, list, m.index)) {
      hits.push({
        line: text.slice(0, m.index).split('\n').length,
        arg: arg.trim().replace(/\s+/g, ' ').slice(0, 90),
      });
    }
  }
  return hits;
}

function selfTest() {
  const cases = [
    {
      name: 'bare fetch to a hub.url-derived var (the original bug)',
      src: "const base = cfg.get('hub.url');\nasync function f() {\n  const r = await fetch(base + '/status');\n}",
      expect: 1,
    },
    {
      name: 'literal :7878',
      src: "async function f() {\n  await fetch('http://127.0.0.1:7878/status');\n}",
      expect: 1,
    },
    {
      name: 'chained variable (base -> u) still flags',
      src: "const base = cfg.get('hub.url');\nconst u = base + '/status';\nasync function f() {\n  await fetch(u);\n}",
      expect: 1,
    },
    {
      name: 'authenticated hubFetch (correct form)',
      src: "const base = cfg.get('hub.url');\nasync function f() {\n  const r = await hubFetch(base + '/status');\n}",
      expect: 0,
    },
    {
      name: 'shadowed variable named like a Hub var (must NOT flag)',
      src: "const url = cfg.get('hub.url');\nasync function f() {\n  const url = 'https://api.github.com/x';\n  return fetch(url);\n}",
      expect: 0,
    },
    {
      name: 'non-Hub backend fetch (must NOT flag)',
      src: "const b = cfg.get('backendUrl');\nasync function f() {\n  await fetch(b + '/ext/v1/health');\n}",
      expect: 0,
    },
  ];
  let ok = true;
  for (const c of cases) {
    const got = scan(c.src).length;
    const pass = got === c.expect;
    ok = ok && pass;
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${c.name}  (expected ${c.expect}, got ${got})`);
  }
  console.log(ok ? 'self-test: OK' : 'self-test: FAILED');
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes('--self-test')) selfTest();

const violations = [];
for (const file of listFiles(SRC)) {
  if (EXEMPT.has(path.basename(file))) continue;
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  for (const hit of scan(fs.readFileSync(file, 'utf8'))) violations.push({ rel, ...hit });
}

if (!violations.length) {
  console.log('check-hub-auth: OK — every Hub call goes through hubClient.');
  process.exit(0);
}
console.error('check-hub-auth: FAILED — these Hub calls must use hubFetch from ./hubClient:');
for (const v of violations) console.error(`  ${v.rel}:${v.line}  ${v.arg}`);
process.exit(1);
