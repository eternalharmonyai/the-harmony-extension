import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface ChatHistoryEntry {
    id: string;
    timestamp: string;
    prompt?: string;
    response?: string;
    role?: 'user' | 'assistant';
}

export const HARMONY_HISTORY_SCHEME = 'harmony-history';

// Ledger is sharded by month: chat_ledger-YYYY-MM.jsonl. Sharding is file
// management only — the resolver scans all shards (never derives a shard from
// an id), so there is no date-parsing, no NaN, and no rotation cliff.
function ledgerShardFilename(date: Date): string {
    return `chat_ledger-${date.toISOString().slice(0, 7)}.jsonl`;
}

// Multi-root safe: prefer the folder containing the active editor, then the
// rest of the workspace folders in order. Mirrors the same priority helper in
// toolExecutor.ts so reads and writes agree on "which folder is current".
function workspaceFoldersByPriority(): readonly vscode.WorkspaceFolder[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const active = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    if (!activeFolder) return folders;
    return [activeFolder, ...folders.filter(folder => folder.uri.toString() !== activeFolder.uri.toString())];
}

export class ChatHistoryProvider implements vscode.TextDocumentContentProvider {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        // Full-conversation view: harmony-history:/conversation.md
        // (MUST be a single slash — a `//` here turns "conversation.md" into
        //  an authority and leaves uri.path empty, which breaks this match.)
        if (uri.path === '/conversation.md') {
            return await buildConversationMarkdown();
        }
        // uri format: harmony-history://prompt/1717081234.md
        const match = uri.path.match(/^\/(\d+)\.md$/);
        const id = match ? match[1] : uri.path.replace(/^\//, '').replace(/\.md$/, '');
        
        const folders = workspaceFoldersByPriority();
        if (folders.length === 0) return 'Error: No workspace open.';
        
        // Scan, never derive — across EVERY workspace folder (multi-root safe):
        // check monthly shards (newest first), then the frozen legacy
        // chat_ledger.jsonl, then any rotated archive/*.jsonl. No id→shard
        // computation, so no date-parsing, no NaN, no -r special case.
        const candidates: string[] = [];
        for (const folder of folders) {
            const historyDir = path.join(folder.uri.fsPath, '.harmony', 'history');
            try {
                const names = await fs.readdir(historyDir);
                for (const n of names.filter(n => /^chat_ledger-\d{4}-\d{2}\.jsonl$/.test(n)).sort().reverse()) {
                    candidates.push(path.join(historyDir, n));
                }
            } catch { /* no shards yet */ }
            candidates.push(path.join(historyDir, 'chat_ledger.jsonl'));
            try {
                const archiveDir = path.join(historyDir, 'archive');
                const names = await fs.readdir(archiveDir);
                for (const n of names.sort()) {
                    if (n.endsWith('.jsonl')) candidates.push(path.join(archiveDir, n));
                }
            } catch { /* no archive dir yet */ }
        }

        for (const file of candidates) {
            try {
                const content = await fs.readFile(file, 'utf8');
                for (const line of content.split('\n')) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    let entry: ChatHistoryEntry;
                    try { entry = JSON.parse(trimmed) as ChatHistoryEntry; } catch { continue; }
                    if (entry.id === id) {
                        return `> **Harmony Auto-Draft** (${entry.timestamp})\n> Restored automatically from the Chat Ledger.\n\n${entry.prompt}\n`;
                    }
                }
            } catch { /* skip unreadable candidate */ }
        }
        return `Error: Prompt ${id} not found in the ledger.`;
    }
}

export function registerChatHistoryProvider(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(HARMONY_HISTORY_SCHEME, new ChatHistoryProvider())
    );
}

export async function appendChatHistory(prompt: string): Promise<vscode.Uri | undefined> {
    try {
        const root = workspaceFoldersByPriority()[0]?.uri.fsPath;
        if (!root) return undefined;

        const historyDir = path.join(root, '.harmony', 'history');
        try { await fs.mkdir(historyDir, { recursive: true }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }

        const now = new Date();
        // Numeric id with a short random suffix: avoids same-millisecond
        // collisions while keeping the id parseable by the \d+ URI regex and
        // within Number.MAX_SAFE_INTEGER (16 digits, round-trips exactly).
        const id = `${now.getTime()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
        
        const entry: ChatHistoryEntry = {
            id,
            timestamp: now.toISOString(),
            prompt
        };

        await fs.appendFile(path.join(historyDir, ledgerShardFilename(now)), JSON.stringify(entry) + '\n', 'utf8');

        return vscode.Uri.parse(`${HARMONY_HISTORY_SCHEME}://prompt/${id}.md`);
    } catch (e) {
        return undefined;
    }
}

export async function appendChatResponse(promptId: string | undefined, responseText: string): Promise<void> {
    try {
        const root = workspaceFoldersByPriority()[0]?.uri.fsPath;
        if (!root) return;
        const text = (responseText ?? '').trim();
        if (!text) return;
        const historyDir = path.join(root, '.harmony', 'history');
        try { await fs.mkdir(historyDir, { recursive: true }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
        const now = new Date();
        const id = promptId ? `${promptId}-r` : `${now.getTime()}-r`;
        const entry: ChatHistoryEntry = {
            id,
            timestamp: now.toISOString(),
            response: text,
            role: 'assistant',
        };
        await fs.appendFile(path.join(historyDir, ledgerShardFilename(now)), JSON.stringify(entry) + '\n', 'utf8');
    } catch {
        // best-effort: never break the chat turn over history capture
    }
}

export async function buildConversationMarkdown(): Promise<string> {
    const folders = workspaceFoldersByPriority();
    if (folders.length === 0) return 'Error: No workspace open.';

    const out: string[] = [
        '# Harmony Conversation',
        '',
        `Generated: ${new Date().toISOString()}`,
        '',
    ];

    const memoryFiles: { file: string; root: string }[] = [];
    for (const folder of folders) {
        const root = folder.uri.fsPath;
        const memPath = path.join(root, '.harmony', 'memory.jsonl');
        try { await fs.access(memPath); memoryFiles.push({ file: memPath, root }); } catch { /* no memory file */ }
        const preservedDir = path.join(root, '.harmony', 'memory-preserved');
        try {
            const names = await fs.readdir(preservedDir);
            for (const n of names.sort()) {
                if (n.endsWith('.jsonl')) memoryFiles.push({ file: path.join(preservedDir, n), root });
            }
        } catch { /* no preserved dir */ }
    }

    let total = 0;
    for (const { file, root } of memoryFiles) {
        let content = '';
        try { content = await fs.readFile(file, 'utf8'); } catch { continue; }
        const section: string[] = [];
        let fileCount = 0;
        for (const line of content.split(/\r?\n/)) {
            const t = line.trim();
            if (!t) continue;
            let entry: any;
            try { entry = JSON.parse(t); } catch { continue; }
            if (typeof entry.prompt === 'string' && entry.prompt.trim()) {
                section.push('## 🙋 You', '', entry.prompt.trim(), '');
                fileCount++;
            }
            if (typeof entry.response === 'string' && entry.response.trim()) {
                section.push('## 🤖 Harmony', '', entry.response.trim(), '');
                fileCount++;
            }
        }
        if (fileCount > 0) {
            out.push('---', '', `### Source: ${path.relative(root, file)}`, '', ...section);
            total += fileCount;
        }
    }

    if (total === 0) out.push('_No conversation entries found yet._');
    return out.join('\n');
}