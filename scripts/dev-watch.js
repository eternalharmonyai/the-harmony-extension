#!/usr/bin/env node
/**
 * Harmony dev-watch.
 * - Runs `tsc --watch` so TypeScript recompiles on change
 * - When out/ changes, rebuilds the .vsix and reinstalls into VS Code
 *
 * Usage:  npm run dev
 * Stop:   Ctrl+C
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const VSIX = 'harmony-extension.vsix';
const VSCODE_CLI = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd')
    : 'code';

let rebuilding = false;
let pendingRebuild = false;
let lastTrigger = 0;
const DEBOUNCE_MS = 1500;

function rebuildAndInstall() {
    if (rebuilding) { pendingRebuild = true; return; }
    rebuilding = true;
    console.log('\n[dev] packaging vsix...');
    const pkg = spawnSync('npx', ['--yes', '@vscode/vsce', 'package', '--out', VSIX], {
        cwd: ROOT, stdio: 'inherit', shell: true
    });
    if (pkg.status !== 0) {
        console.error('[dev] package failed (status ' + pkg.status + ')');
        rebuilding = false;
        return;
    }
    console.log('[dev] installing vsix...');
    const inst = spawnSync(VSCODE_CLI, ['--install-extension', VSIX, '--force'], {
        cwd: ROOT, stdio: 'inherit', shell: true
    });
    if (inst.status !== 0) {
        console.error('[dev] install failed (status ' + inst.status + ')');
    } else {
        console.log('[dev] reinstalled. Run "Developer: Reload Window" in VS Code to pick it up.');
    }
    rebuilding = false;
    if (pendingRebuild) { pendingRebuild = false; rebuildAndInstall(); }
}

function scheduleRebuild() {
    const now = Date.now();
    if (now - lastTrigger < DEBOUNCE_MS) return;
    lastTrigger = now;
    setTimeout(rebuildAndInstall, DEBOUNCE_MS);
}

console.log('[dev] starting tsc --watch ...');
const tsc = spawn('npx', ['tsc', '--watch', '-p', './'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], shell: true
});
tsc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    // tsc prints "Found 0 errors. Watching for file changes." after each successful build
    if (text.includes('Found 0 errors')) scheduleRebuild();
});

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

process.on('SIGINT', () => { tsc.kill(); process.exit(0); });
