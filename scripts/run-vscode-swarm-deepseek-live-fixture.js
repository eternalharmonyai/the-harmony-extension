const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

const root = path.resolve(__dirname, '..');
process.env.HARMONY_FIXTURE_REPORT_ROOT = root;
const dotenvPath = path.join(root, '.env');
if (fs.existsSync(dotenvPath) && !process.env.HARMONY_REAL_DOTENV) {
    process.env.HARMONY_REAL_DOTENV = dotenvPath;
}

const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-vscode-swarm-deepseek-live-'));
const workspace = path.join(tempBase, 'workspace');
const userData = path.join(tempBase, 'user-data');
const extensions = path.join(tempBase, 'extensions');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(extensions, { recursive: true });

function defaultVsCodeExecutable() {
    if (process.env.VSCODE_BIN) return process.env.VSCODE_BIN;
    if (process.platform === 'win32') {
        const local = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe');
        if (fs.existsSync(local)) return local;
    }
    return undefined;
}

function latestLiveReport() {
    const smokeDir = path.join(root, '.harmony', 'smoke');
    if (!fs.existsSync(smokeDir)) return undefined;
    const names = fs.readdirSync(smokeDir)
        .filter((name) => /^vscode-swarm-deepseek-live-fixture-.*\.json$/.test(name))
        .sort()
        .reverse();
    for (const name of names) {
        const target = path.join(smokeDir, name);
        try {
            return JSON.parse(fs.readFileSync(target, 'utf8'));
        } catch {
            // Ignore malformed old reports.
        }
    }
    return undefined;
}

(async () => {
    try {
        await runTests({
            vscodeExecutablePath: defaultVsCodeExecutable(),
            extensionDevelopmentPath: root,
            extensionTestsPath: path.join(root, 'test', 'vscode-swarm-deepseek-live-fixture.js'),
            launchArgs: [
                workspace,
                '--disable-extensions',
                '--user-data-dir', userData,
                '--extensions-dir', extensions,
            ],
        });
        const report = latestLiveReport();
        if (!report || report.status !== 'passed') {
            throw new Error(`live DeepSeek swarm fixture did not pass${report?.error ? `: ${report.error}` : ''}`);
        }
    } finally {
        try {
            fs.rmSync(tempBase, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup only; the fixture report avoids writing provider text or secrets.
        }
    }
})().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
});