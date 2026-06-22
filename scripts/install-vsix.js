const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const direct = process.argv.find(arg => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function candidatePaths(editor) {
  if (process.platform !== 'win32') {
    return editor === 'cursor' ? ['cursor'] : ['code'];
  }

  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  if (editor === 'cursor') {
    return [
      path.join(local, 'Programs', 'cursor', 'resources', 'app', 'codeBin', 'code.cmd'),
      path.join(local, 'Programs', 'Cursor', 'resources', 'app', 'codeBin', 'code.cmd'),
      'cursor',
    ];
  }

  return [
    path.join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    path.join(programFiles, 'Microsoft VS Code', 'bin', 'code.cmd'),
    path.join(programFilesX86, 'Microsoft VS Code', 'bin', 'code.cmd'),
    'code',
  ];
}

function commandExists(command) {
  if (command.includes(path.sep) || command.endsWith('.cmd')) {
    return fs.existsSync(command);
  }
  const checker = process.platform === 'win32' ? 'where.exe' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  return cp.spawnSync(checker, args, { stdio: 'ignore' }).status === 0;
}

function resolveCommand(editor) {
  return candidatePaths(editor).find(commandExists);
}

function quotePowerShellArg(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runEditorCommand(command, args) {
  if (process.platform === 'win32' && command.endsWith('.cmd')) {
    const commandLine = `& ${[command, ...args].map(quotePowerShellArg).join(' ')}`;
    return cp.spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', commandLine], { stdio: 'inherit' });
  }
  return cp.spawnSync(command, args, { stdio: 'inherit' });
}

function runEditorCommandCapture(command, args) {
  if (process.platform === 'win32' && command.endsWith('.cmd')) {
    const commandLine = `& ${[command, ...args].map(quotePowerShellArg).join(' ')}`;
    return cp.spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', commandLine], { encoding: 'utf8' });
  }
  return cp.spawnSync(command, args, { encoding: 'utf8' });
}

function packageInfo() {
  const packagePath = path.resolve(__dirname, '..', 'package.json');
  return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
}

function defaultVsixPath(pkg) {
  return `harmony-extension-${pkg.version}.vsix`;
}

function repoRoot() {
  return path.resolve(__dirname, '..');
}

function installedVersions(editor, command, pkg) {
  const extensionId = `${pkg.publisher}.${pkg.name}`;
  const result = runEditorCommandCapture(command, ['--list-extensions', '--show-versions']);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${editor} version verification failed with exit code ${result.status}: ${result.stderr || result.stdout || ''}`.trim());
  }
  return String(result.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith(`${extensionId}@`));
}

function verifyInstalled(editor, command, pkg) {
  const extensionId = `${pkg.publisher}.${pkg.name}`;
  const expected = `${extensionId}@${pkg.version}`;
  const lines = installedVersions(editor, command, pkg);
  if (!lines.includes(expected)) {
    throw new Error(`${editor} installed version mismatch. Expected ${expected}. Found: ${lines.join(', ') || 'missing'}`);
  }
  console.log(`Verified ${editor}: ${expected}`);
}

function install(editor, vsixPath, pkg, verify, dryRun) {
  const command = resolveCommand(editor);
  if (!command) {
    throw new Error(`Could not find ${editor} CLI. Checked: ${candidatePaths(editor).join(', ')}`);
  }
  const extensionId = `${pkg.publisher}.${pkg.name}`;
  const expected = `${extensionId}@${pkg.version}`;
  if (dryRun) {
    const installed = verify ? installedVersions(editor, command, pkg) : [];
    console.log(`Dry run ${editor}: would install ${vsixPath} with ${command}`);
    console.log(`Expected after install: ${expected}`);
    if (verify) console.log(`Currently installed: ${installed.join(', ') || 'missing'}`);
    return { editor, command, vsixPath, expected, currentInstalled: installed };
  }
  console.log(`Installing ${vsixPath} into ${editor} with ${command}`);
  const result = runEditorCommand(command, ['--install-extension', vsixPath, '--force']);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${editor} install failed with exit code ${result.status}`);
  }
  if (verify) verifyInstalled(editor, command, pkg);
  return { editor, command, vsixPath, expected, installed: true };
}

const editor = argValue('editor', 'vscode').toLowerCase();
const pkg = packageInfo();
const vsix = argValue('vsix', defaultVsixPath(pkg));
const verify = String(argValue('verify', 'true')).toLowerCase() !== 'false';
const dryRun = hasFlag('dry-run') || String(argValue('dryRun', 'false')).toLowerCase() === 'true';
const targets = editor === 'both' ? ['vscode', 'cursor'] : [editor];

if (!['vscode', 'cursor', 'both'].includes(editor)) {
  throw new Error('Use --editor vscode, --editor cursor, or --editor both.');
}
if (!fs.existsSync(vsix)) {
  throw new Error(`VSIX not found: ${vsix}`);
}
const results = [];
for (const target of targets) {
  results.push(install(target, vsix, pkg, verify, dryRun));
}
if (dryRun) {
  const releaseDir = path.join(repoRoot(), '.harmony', 'release');
  fs.mkdirSync(releaseDir, { recursive: true });
  const id = `install-dry-run-${pkg.version}-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const reportPath = path.join(releaseDir, `${id}.json`);
  const report = {
    version: 1,
    id,
    kind: 'install.dryRun',
    createdAt: new Date().toISOString(),
    package: { name: pkg.name, publisher: pkg.publisher, version: pkg.version },
    vsix: { path: path.resolve(vsix), exists: true },
    targets: results,
    status: results.length === targets.length ? 'passed' : 'failed',
    installed: false,
    reloadedEditors: false,
    notes: ['Dry-run only. No extension was installed and no editor was reloaded.'],
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`Dry-run report: ${reportPath}`);
  console.log('No extension was installed. When ready, run the same command without --dry-run, then reload VS Code and Cursor.');
}
