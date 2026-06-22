const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const npmCommand = 'npm';
const nodeCommand = process.execPath;
const startedAt = new Date();
const steps = [];

function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

function reportPath(version) {
  const dir = path.join(root, '.harmony', 'release');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `self-update-checkpoint-${version}-${stamp}-${process.pid}.json`);
}

function run(label, command, args) {
  const start = Date.now();
  console.log(`\n== ${label}`);
  console.log([command, ...args].join(' '));
  const result = childProcess.spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command === npmCommand,
    windowsHide: false,
  });
  const code = typeof result.status === 'number' ? result.status : 1;
  steps.push({ label, command: [command, ...args], exitCode: code, durationMs: Date.now() - start, error: result.error ? String(result.error.message || result.error) : undefined });
  if (result.error) throw result.error;
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}`);
}

function writeReport(status, error) {
  const version = readVersion();
  const target = reportPath(version);
  const payload = {
    version: 1,
    packageVersion: version,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    workspace: root,
    vsix: `harmony-extension-${version}.vsix`,
    authority: {
      installsVsix: false,
      reloadsEditors: false,
      callsPaidProviders: false,
      mutatesGit: false,
      runsLiveDeepSeekFixture: false,
    },
    steps,
    error: error ? String(error.message || error) : undefined,
  };
  fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\nSelf-update checkpoint report: ${target}`);
}

function main() {
  const version = readVersion();
  const vsix = `harmony-extension-${version}.vsix`;
  console.log(`Harmony package-only self-update checkpoint for ${version}`);
  console.log('This does not install the VSIX, reload editors, call paid providers, or mutate git.');

  run('compile', npmCommand, ['run', 'compile']);
  run('model routing smoke', npmCommand, ['run', 'smoke:model-routing']);
  run('browser tooling smoke', npmCommand, ['run', 'smoke:browser-tooling']);
  run('sidebar provider smoke', npmCommand, ['run', 'smoke:sidebar-provider']);
  run('authority boundaries smoke', npmCommand, ['run', 'smoke:authority-boundaries']);
  run('source-write execute smoke', npmCommand, ['run', 'smoke:source-write-execute']);
  run('authority matrix smoke', npmCommand, ['run', 'smoke:authority-matrix']);
  run('provider live harness smoke (no provider calls)', npmCommand, ['run', 'smoke:provider-live-harness']);
  run('native UI visual smoke', npmCommand, ['run', 'smoke:native-ui-visual']);
  run('VS Code provider key import fixture', npmCommand, ['run', 'smoke:vscode-provider-key-import']);
  run('phase3 disposable smoke', nodeCommand, ['bin/harmony-cli.js', 'smoke', 'phase3']);
  run('disposable VS Code swarm fixture', npmCommand, ['run', 'smoke:vscode-swarm-fixture']);
  run('public privacy guard', nodeCommand, ['scripts/run-git-privacy-guard.js', '--paths', 'package.json', 'package-lock.json', 'src', 'docs', 'scripts', 'bin', 'native-ui', '--json']);
  run('package VSIX', npmCommand, ['run', 'package']);
  run('VSIX privacy scan', nodeCommand, ['bin/harmony-cli.js', 'privacy-scan', '--vsix', vsix]);
  run('install dry run only', npmCommand, ['run', 'install:vsix:both:dry-run']);
  run('package-only release receipt', nodeCommand, ['bin/harmony-cli.js', 'release-receipt', '--vsix', vsix, '--package-only']);
  run('seat handoff bundle', npmCommand, ['run', 'self-update:handoff']);
  writeReport('passed');
  console.log('\nHarmony package-only self-update checkpoint passed. Install/reload is intentionally deferred.');
}

try {
  main();
} catch (error) {
  writeReport('failed', error);
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}