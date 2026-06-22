const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

const root = path.resolve(__dirname, '..');
process.env.HARMONY_FIXTURE_REPORT_ROOT = root;
const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-vscode-provider-key-import-'));
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

(async () => {
    try {
        await runTests({
            vscodeExecutablePath: defaultVsCodeExecutable(),
            extensionDevelopmentPath: root,
            extensionTestsPath: path.join(root, 'test', 'vscode-provider-key-import-fixture.js'),
            launchArgs: [
                workspace,
                '--disable-extensions',
                '--user-data-dir', userData,
                '--extensions-dir', extensions,
            ],
        });
    } finally {
        try {
            fs.rmSync(tempBase, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup only; the fixture report records the tested workspace path.
        }
    }
})().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
});