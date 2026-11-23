#!/usr/bin/env node
'use strict';
/**
 * Reproducible, zero-path-leak builder for `harmony-native-control(.exe)`.
 *
 * Applies `--remap-path-prefix` across `os.homedir()`, `CARGO_HOME`, `RUSTUP_HOME`,
 * and the workspace root (covering uppercase/lowercase Windows drive letters) so
 * compiled `.rdata` panic locations never embed developer OS usernames or local paths.
 */
const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TAURI_DIR = path.join(ROOT, 'native-ui', 'src-tauri');
const EXE_NAME = process.platform === 'win32' ? 'harmony-native-control.exe' : 'harmony-native-control';

function variants(p) {
  if (!p) return [];
  const out = new Set([p]);
  if (/^[A-Za-z]:\\/.test(p)) {
    out.add(p[0].toUpperCase() + p.slice(1));
    out.add(p[0].toLowerCase() + p.slice(1));
    const slash = p.replace(/\\/g, '/');
    out.add(slash[0].toUpperCase() + slash.slice(1));
    out.add(slash[0].toLowerCase() + slash.slice(1));
  }
  return Array.from(out);
}

const home = os.homedir();
const cargoHome = process.env.CARGO_HOME || path.join(home, '.cargo');
const rustupHome = process.env.RUSTUP_HOME || path.join(home, '.rustup');

const remapFlags = [];
for (const v of variants(cargoHome)) remapFlags.push('--remap-path-prefix', `${v}=/cargo`);
for (const v of variants(rustupHome)) remapFlags.push('--remap-path-prefix', `${v}=/rustup`);
for (const v of variants(ROOT)) remapFlags.push('--remap-path-prefix', `${v}=/workspace`);
for (const v of variants(home)) remapFlags.push('--remap-path-prefix', `${v}=/home`);

const env = {
  ...process.env,
  CARGO_ENCODED_RUSTFLAGS: remapFlags.join('\x1f'),
};
delete env.RUSTFLAGS;

console.log('[build-native-control] Running cargo test + privacy-remapped release build...');
const testRes = cp.spawnSync('cargo', ['test'], { cwd: TAURI_DIR, stdio: 'inherit', env });
if (testRes.status !== 0) process.exit(testRes.status || 1);

const buildRes = cp.spawnSync('cargo', ['build', '--release'], { cwd: TAURI_DIR, stdio: 'inherit', env });
if (buildRes.status !== 0) process.exit(buildRes.status || 1);

const builtPath = path.join(TAURI_DIR, 'target', 'release', EXE_NAME);
const binDest = path.join(ROOT, 'bin', EXE_NAME);
const userBinDir = path.join(home, '.harmony', 'bin');
fs.mkdirSync(path.dirname(binDest), { recursive: true });
fs.mkdirSync(userBinDir, { recursive: true });
fs.copyFileSync(builtPath, binDest);
fs.copyFileSync(builtPath, path.join(userBinDir, EXE_NAME));

const digest = crypto.createHash('sha256').update(fs.readFileSync(binDest)).digest('hex').toUpperCase();
const bytes = fs.statSync(binDest).size;
console.log(`[build-native-control] READY ${EXE_NAME} (${bytes} bytes, sha256=${digest})`);
