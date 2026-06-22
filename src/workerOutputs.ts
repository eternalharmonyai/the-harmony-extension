/**
 * Worker Output Files — save complete worker/spawn outputs to .harmony/worker-outputs/
 * to prevent truncation when workers produce very long outputs.
 *
 * Workers/spawn_worker/parallel agents can produce outputs that exceed token limits
 * and get truncated in chat. This module saves the FULL output to dated files so
 * the parent agent can always access the complete result.
 *
 * Files are saved under: .harmony/worker-outputs/YYYY-MM-DD/<timestamp>-<label>.md
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';

const textEncoder = new TextEncoder();

function isEnabled(): boolean {
    return vscode.workspace.getConfiguration('harmony').get<boolean>('workerOutputs.enabled') ?? true;
}

function outputDir(): vscode.Uri | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    const today = new Date().toISOString().slice(0, 10);
    return vscode.Uri.joinPath(folders[0].uri, '.harmony', 'worker-outputs', today);
}

async function ensureDir(uri: vscode.Uri): Promise<void> {
    try { await vscode.workspace.fs.createDirectory(uri); } catch { /* ok */ }
}

/**
 * Save a worker output to .harmony/worker-outputs/.
 * @param label - Human-readable label (role, provider, worker name)
 * @param content - Full output text
 * @param metadata - Optional extra context (task, provider, tier, etc.)
 * @returns Workspace-relative path to the saved file, or null if disabled/failed
 */
export async function saveWorkerOutput(
    label: string,
    content: string,
    metadata?: Record<string, string>
): Promise<string | null> {
    if (!isEnabled()) return null;
    const dir = outputDir();
    if (!dir) return null;

    try {
        await ensureDir(dir);
        const ts = Date.now();
        const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
        const shortHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
        const fileName = `${ts}-${safeLabel}-${shortHash}.md`;
        const fileUri = vscode.Uri.joinPath(dir, fileName);

        let md = `# Worker Output: ${label}\n`;
        md += `- **Saved:** ${new Date(ts).toISOString()}\n`;
        md += `- **Length:** ${content.length} characters\n`;
        md += `- **SHA256:** ${shortHash}…\n`;
        if (metadata) {
            for (const [k, v] of Object.entries(metadata)) {
                md += `- **${k}:** ${v}\n`;
            }
        }
        md += `\n---\n\n${content}\n`;

        await vscode.workspace.fs.writeFile(fileUri, textEncoder.encode(md));

        // Return workspace-relative path (works across OS)
        const folders = vscode.workspace.workspaceFolders!;
        const relPath = path.relative(folders[0].uri.fsPath, fileUri.fsPath);
        return relPath.replace(/\\/g, '/');
    } catch {
        return null; // Best-effort, never throw
    }
}

/**
 * Read a previously saved worker output file.
 * @param filePath - Workspace-relative path (as returned by saveWorkerOutput)
 */
export async function readWorkerOutput(filePath: string): Promise<string | null> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    try {
        const uri = vscode.Uri.joinPath(folders[0].uri, ...filePath.split('/'));
        const raw = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(raw).toString('utf-8');
    } catch {
        return null;
    }
}

/**
 * List recent worker output files.
 */
export async function listWorkerOutputs(limit = 20): Promise<{ path: string; label: string; ts: number; length: number }[]> {
    const dir = outputDir();
    if (!dir) return [];
    try {
        const entries = await vscode.workspace.fs.readDirectory(dir);
        const files = entries
            .filter(([, t]) => t === vscode.FileType.File && /.md$/.test(''))
            .map(([name]) => {
                const parts = name.match(/^(\d+)-(.+)-([0-9a-f]+)\.md$/);
                const ts = parts ? parseInt(parts[1], 10) : 0;
                const label = parts ? parts[2].replace(/_/g, ' ') : name;
                return { name, ts, label };
            })
            .sort((a, b) => b.ts - a.ts)
            .slice(0, limit);

        const folders = vscode.workspace.workspaceFolders!;
        return files.map(f => ({
            path: path.relative(folders[0].uri.fsPath, vscode.Uri.joinPath(dir, f.name).fsPath).replace(/\\/g, '/'),
            label: f.label,
            ts: f.ts,
            length: 0, // lazily loaded
        }));
    } catch {
        return [];
    }
}
