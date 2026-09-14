#!/usr/bin/env node
'use strict';
/**
 * Guard: no TypeScript-only syntax may survive into a webview <script> block.
 *
 * Why this exists: the sidebar/panels are rendered from JavaScript template
 * literals in TypeScript source. `tsc` does NOT process template literal
 * contents — they are opaque strings. So a single TypeScript-ism inside a
 * `<script>` block compiles cleanly, ships, and then crashes the ENTIRE script
 * in the browser with a SyntaxError. The visible result is a dead panel:
 * checkboxes that move but do nothing, settings that revert on reload, and a
 * blank slate every time.
 *
 * This bug class has recurred repeatedly. Forms seen in practice include:
 *   - `as HTMLInputElement` / `as HTMLSelectElement` casts
 *   - `let icon: string`                     type annotation
 *   - `(t: any) => t.tag`                    typed arrow parameter
 *   - `(r: any, i: number) =>`               typed arrow parameters
 *   - `(p: { id: string; ... }) =>`          object type literal
 *   - `(btn as HTMLElement)`                 cast
 *   - `let counts: string`                   type annotation
 *
 * Two independent checks:
 *   1. SOURCE  — scan `<script>` regions in the webview-producing sources for
 *                TypeScript-only constructs.
 *   2. COMPILED — extract each `<script>` block from the compiled out/*.js and
 *                parse it with vm.Script. If it does not parse as JavaScript,
 *                the shipped panel would be dead.
 *
 * Usage:  node scripts/check-webview-js.js [--self-test]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// Sources that emit an inline webview <script> block.
const SOURCES = [
  'src/sidebar.ts',
  'src/askView.ts',
  'src/composeView.ts',
  'src/chatViewProvider.ts',
  'src/extension.ts',
];

// TypeScript-only constructs that must never appear inside a <script> block.
// Each entry: [regex, human label]. Applied per stripped line.
const FORBIDDEN = [
  [/\bas\s+(HTML\w+|SVG\w+|Record\s*<|string|number|boolean|any|unknown|[A-Z]\w+)/, 'as-cast'],
  [/\b(let|const|var)\s+[A-Za-z_$][\w$]*\s*:\s*[A-Za-z_$]/, 'variable type annotation'],
  [/\([A-Za-z_$][\w$]*\s*:\s*(any|string|number|boolean|unknown)\b/, 'typed parameter'],
  [/\([A-Za-z_$][\w$]*\s*:\s*\{/, 'object type literal parameter'],
  [/\)\s*:\s*(string|number|boolean|void|any|unknown|Promise)\b/, 'return type annotation'],
  [/\bsatisfies\s+[A-Za-z_$]/, 'satisfies operator'],
  [/\b(interface|enum|namespace)\s+[A-Z]/, 'TS-only keyword'],
  [/<[A-Z][A-Za-z0-9_]*>\s*\(/, 'angle-bracket cast'],
];

function stripLineToCommentsOnly(line) {
  // Blank out string literals so that prose in strings cannot false-positive,
  // but KEEP the line so column positions stay meaningful.
  return line
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** Extract inner text of every <script ...> ... </script> in a file. */
function scriptBlocks(text) {
  const out = [];
  const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(0, m.index);
    const startLine = before.split(/\r?\n/).length;
    out.push({ body: m[1], startLine });
  }
  return out;
}

/** Replace ${ ... } (brace- and string-aware) with 0 so template text becomes
 *  standalone-parseable JavaScript. */
function neutralizeTemplate(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '$' && text[i + 1] === '{') {
      let depth = 1, j = i + 2, inStr = null;
      while (j < text.length && depth > 0) {
        const c = text[j];
        if (inStr) {
          if (c === '\\') j++;
          else if (c === inStr) inStr = null;
        } else if (c === '"' || c === "'" || c === '`') inStr = c;
        else if (c === '{') depth++;
        else if (c === '}') depth--;
        j++;
      }
      out += '0';
      i = j - 1;
    } else {
      out += text[i];
    }
  }
  return out;
}

function checkSource(failures) {
  for (const rel of SOURCES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.split(/\r?\n/);
    for (const block of scriptBlocks(text)) {
      const bodyLines = block.body.split(/\r?\n/);
      bodyLines.forEach((raw, i) => {
        const line = stripLineToCommentsOnly(raw);
        for (const [re, label] of FORBIDDEN) {
          if (re.test(line)) {
            failures.push(
              rel + ':' + (block.startLine + i + 1) + '  [' + label + ']  ' + raw.trim().slice(0, 140)
            );
            break;
          }
        }
      });
    }
  }
}

function checkCompiled(failures) {
  const outDir = path.join(ROOT, 'out');
  if (!fs.existsSync(outDir)) return;
  for (const rel of SOURCES) {
    const js = path.join(outDir, path.basename(rel).replace(/\.ts$/, '.js'));
    if (!fs.existsSync(js)) continue;
    const text = fs.readFileSync(js, 'utf8');
    let idx = 0;
    for (const block of scriptBlocks(text)) {
      idx++;
      const body = neutralizeTemplate(block.body);
      try {
        new vm.Script(body, { filename: path.basename(js) + '#script' + idx });
      } catch (e) {
        const lineMatch = /#script\d+:(\d+)/.exec(String(e.stack || ''));
        const badLine = lineMatch ? body.split(/\r?\n/)[Number(lineMatch[1]) - 1] : '';
        failures.push(
          path.basename(js) + ' script#' + idx + '  DOES NOT PARSE: ' + (e.message || e) +
          (badLine ? '  >> ' + String(badLine).trim().slice(0, 140) : '')
        );
      }
    }
  }
}

function main() {
  const selfTest = process.argv.includes('--self-test');

  if (selfTest) {
    // Prove the detector actually catches the bug it exists to prevent.
    const sample = 'let counts: string;\n';
    const hit = FORBIDDEN.some(([re]) => re.test(sample));
    try {
      new vm.Script(sample);
      console.log('SELF-TEST FAILED: stale sample parsed as JS (detector blind).');
      process.exit(1);
    } catch { /* expected */ }
    if (!hit) {
      console.log('SELF-TEST FAILED: regex did not flag the sample.');
      process.exit(1);
    }
    console.log('SELF-TEST PASS: detector flags the sample and vm.Script rejects it.');
    return;
  }

  const failures = [];
  checkSource(failures);
  checkCompiled(failures);

  if (failures.length) {
    console.error('');
    console.error('webview-js guard FAILED — TypeScript syntax would reach the browser:');
    for (const f of failures) console.error('  - ' + f);
    console.error('');
    console.error('A single one of these kills the ENTIRE webview script (blank panel,');
    console.error('toggles that do not persist).');
    console.error('');
    process.exit(1);
  }

  console.log('webview-js guard: OK (no TS syntax in <script>; all compiled scripts parse).');
}

main();
