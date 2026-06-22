import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as cp from 'child_process';

async function pathExists(absPath: string): Promise<boolean> {
    return fs.access(absPath).then(() => true).catch(() => false);
}

async function readJsonFile(absPath: string): Promise<Record<string, unknown> | undefined> {
    try { return JSON.parse(await fs.readFile(absPath, 'utf8')) as Record<string, unknown>; }
    catch { return undefined; }
}

function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function extensionSourcePath(context: vscode.ExtensionContext): Promise<string | undefined> {
    const cfg = vscode.workspace.getConfiguration('harmony');
    const configured = (cfg.get<string>('extensionSourcePath') ?? '').trim();
    const fromEnv = (process.env.HARMONY_EXTENSION_SOURCE ?? '').trim();
    const root = workspaceRoot();
    const candidates = [
        configured,
        fromEnv,
        root,
        root ? path.resolve(root, '..', 'HarmonyExtension') : undefined,
        context.extensionPath,
    ].filter(Boolean) as string[];
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        const packageJson = await readJsonFile(path.join(resolved, 'package.json'));
        if (packageJson?.name === 'harmony-extension') return resolved;
    }
    return undefined;
}

function powershellCommand(): string {
    return process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
}

async function runRestoreScript(scriptPath: string, cwd: string): Promise<{ ok: boolean; output: string }> {
    return await new Promise(resolve => {
        cp.execFile(powershellCommand(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Quiet'], {
            cwd,
            windowsHide: true,
            timeout: 300000,
            maxBuffer: 20 * 1024 * 1024,
        }, (error, stdout, stderr) => {
            const output = [stdout, stderr ? `[stderr]\n${stderr}` : '', error ? `[error]\n${error.message}` : ''].filter(Boolean).join('\n');
            resolve({ ok: !error, output });
        });
    });
}

function backupPathFromOutput(output: string): string | undefined {
    const match = output.match(/Backup folder:\s*(.+)/i);
    return match ? match[1].trim() : undefined;
}

export function registerRepairRestore(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.restoreExtensionEngine', async () => {
            const sourceRoot = await extensionSourcePath(context);
            if (!sourceRoot) {
                const open = await vscode.window.showErrorMessage(
                    'HarmonyExtension source folder was not found. Set harmony.extensionSourcePath before using repair restore.',
                    'Open Settings'
                );
                if (open) vscode.commands.executeCommand('workbench.action.openSettings', 'harmony.extensionSourcePath');
                return;
            }
            const scriptPath = path.join(sourceRoot, 'Restore-HarmonyExtension-Engine.ps1');
            if (!await pathExists(scriptPath)) {
                vscode.window.showErrorMessage(`Repair script not found: ${scriptPath}`);
                return;
            }
            const allowed = await vscode.window.showWarningMessage(
                'Restore HarmonyExtension engine files from the repair baseline? Current engine files are backed up first. Chat, journals, skills, memory, and Central data are not touched.',
                { modal: true },
                'Restore engine files'
            );
            if (allowed !== 'Restore engine files') return;
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Harmony repair restore running...', cancellable: false },
                async () => {
                    const result = await runRestoreScript(scriptPath, sourceRoot);
                    const backupPath = backupPathFromOutput(result.output);
                    const message = result.ok
                        ? `Harmony engine restore complete.${backupPath ? ` Backup folder: ${backupPath}` : ''}`
                        : `Harmony engine restore failed. ${result.output.slice(0, 800)}`;
                    const action = backupPath ? await vscode.window.showInformationMessage(message, 'Open backup folder') : await vscode.window.showInformationMessage(message);
                    if (action === 'Open backup folder' && backupPath) {
                        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(backupPath));
                    }
                }
            );
        })
    );
}