#!/usr/bin/env node
/**
 * Place the HarmonyHub daemon binary into bin/ so it can be packaged.
 *
 * Resolution order:
 *   1. $HARMONY_HUB_EXE                     explicit override
 *   2. ../HarmonyHub/target/release/<exe>   local sibling checkout
 *   3. bin/<exe> already present            reused unchanged
 *
 * Stops the build when no binary can be produced, so a VSIX that cannot start
 * the daemon is never packaged by accident. The SHA256 of whatever gets bundled
 * is printed so a release can be verified against a pinned digest.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const exeName = process.platform === 'win32' ? 'harmonyhub.exe' : 'harmonyhub';
const binDir = path.join(__dirname, '..', 'bin');
const dest = path.join(binDir, exeName);
const sibling = path.resolve(__dirname, '..', '..', 'HarmonyHub', 'target', 'release', exeName);

const sha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();

let source;
for (const candidate of [process.env.HARMONY_HUB_EXE, sibling]) {
  if (candidate && fs.existsSync(candidate)) {
    source = candidate;
    break;
  }
}

if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

if (source) {
  fs.copyFileSync(source, dest);
  // VSIX archives do not reliably preserve the Unix execute bit, so set it here
  // and let the extension re-apply it at spawn time as well.
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dest, 0o755);
    } catch {
      /* best effort; the extension chmods again before spawning */
    }
  }
  console.log(`bundle-hub: bundled ${exeName}`);
  console.log(`bundle-hub: source ${source}`);
  console.log(`bundle-hub: sha256 ${sha256(dest)}`);
  process.exit(0);
}

if (fs.existsSync(dest)) {
  console.log(`bundle-hub: no local build found; reusing the existing bin/${exeName}`);
  console.log(`bundle-hub: sha256 ${sha256(dest)}`);
  process.exit(0);
}

console.error(`bundle-hub: FAILED - no ${exeName} is available to bundle.`);
console.error('');
console.error('The daemon binary must be present before packaging. Without it the VSIX');
console.error('installs but cannot start local recall, so this build is stopped instead');
console.error('of producing a broken package. Provide the binary one of these ways:');
console.error('');
console.error('  1. Build from a sibling checkout:');
console.error('       git clone <harmonyhub-repo> ../HarmonyHub');
console.error('       cargo build --release        (run inside ../HarmonyHub)');
console.error(`  2. Point at an existing build:  HARMONY_HUB_EXE=/path/to/${exeName} npm run package`);
console.error(`  3. Place the binary manually at:  bin/${exeName}`);
console.error('');
process.exit(1);
