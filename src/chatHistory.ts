import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface ChatHistoryEntry {
    id: string;
    timestamp: string;
    prompt: string;
}

export const HARMONY_HISTORY_SCHEME = 'harmony-history';

export class ChatHistoryProvider implements vscode.TextDocumentContentProvider {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        // uri format: harmony-history://prompt/1717081234.md
        const match = uri.path.match(/^\/(\d+)\.md$/);
        const id = match ? match[1] : uri.path.replace(/^\//, '').replace(/\.md$/, '');
        
        const folders = vscode.workspace.workspaceFolders;
        const root = folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
        if (!root) return 'Error: No workspace open.';
        
        const ledgerPath = path.join(root, '.harmony', 'history', 'chat_ledger.jsonl');
        try {
            const content = await fs.readFile(ledgerPath, 'utf8');
            const lines = content.split('\n').filter(l => l.trim().length > 0);
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line) as ChatHistoryEntry;
                    if (entry.id === id) {
                        return `> **Harmony Auto-Draft** (${entry.timestamp})\n> Restored automatically from the Chat Ledger.\n\n${entry.prompt}\n`;
                    }
                } catch (e) {
                    // ignore parse errors for individual lines
                }
            }
            return `Error: Prompt ${id} not found in the ledger.`;
        } catch (e) {
            return `Error reading ledger: ${String(e)}`;
        }
    }
}

export function registerChatHistoryProvider(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(HARMONY_HISTORY_SCHEME, new ChatHistoryProvider())
    );
}

export async function appendChatHistory(prompt: string): Promise<vscode.Uri | undefined> {
    try {
        const folders = vscode.workspace.workspaceFolders;
        const root = folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
        if (!root) return undefined;

        const historyDir = path.join(root, '.harmony', 'history');
        try { await fs.mkdir(historyDir, { recursive: true }); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }

        const ledgerPath = path.join(historyDir, 'chat_ledger.jsonl');
        const now = new Date();
        const id = `${now.getTime()}`;
        
        const entry: ChatHistoryEntry = {
            id,
            timestamp: now.toISOString(),
            prompt
        };

        await fs.appendFile(ledgerPath, JSON.stringify(entry) + '\n', 'utf8');

        return vscode.Uri.parse(`${HARMONY_HISTORY_SCHEME}://prompt/${id}.md`);
    } catch (e) {
        return undefined;
    }
}