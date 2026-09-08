/**
 * Chat Recall — bridges Harmony's own chat ledger into the local BM25 index
 * (institutionalIndex.ts). Every prompt/response pair becomes an IndexedDoc, so
 * the conversation is searchable and citable like any other corpus — the user
 * (or a future agent) can pull up context from any point in time at will.
 */
import * as vscode from 'vscode';
import { clipResult } from './toolResultCap';
import * as fs from 'fs/promises';
import * as path from 'path';
import { searchDocs, type IndexedDoc, type ScoredDoc } from './institutionalIndex';

const CHAT_DOMAIN = 'chat-history';

function clip(text: string): string {
    return clipResult(text);
}

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(clip(text))]);
}

interface LedgerEntry {
    id: string;
    timestamp: string;
    prompt?: string;
    response?: string;
    role?: 'user' | 'assistant';
}

/** Enumerate ledger files: monthly shards (oldest→newest), legacy, archive. */
async function ledgerFiles(root: string): Promise<string[]> {
    const historyDir = path.join(root, '.harmony', 'history');
    const files: string[] = [];
    try {
        const names = await fs.readdir(historyDir);
        for (const n of names.filter(n => /^chat_ledger-\d{4}-\d{2}\.jsonl$/.test(n)).sort()) {
            files.push(path.join(historyDir, n));
        }
    } catch { /* no shards */ }
    files.push(path.join(historyDir, 'chat_ledger.jsonl')); // frozen legacy
    try {
        const archiveDir = path.join(historyDir, 'archive');
        const names = await fs.readdir(archiveDir);
        for (const n of names.sort()) {
            if (n.endsWith('.jsonl')) files.push(path.join(archiveDir, n));
        }
    } catch { /* no archive */ }
    return files;
}

/** Load the ledger and pair each prompt with its response into one IndexedDoc.
 *  Note: reads + tokenizes the full corpus on every call — fine at a few MB,
 *  but add a cached index once the ledger grows past ~5 MB. */
export async function loadChatLedgerDocs(root: string): Promise<IndexedDoc[]> {
    const prompts = new Map<string, LedgerEntry>();
    const responses = new Map<string, LedgerEntry>();
    for (const file of await ledgerFiles(root)) {
        let content = '';
        try { content = await fs.readFile(file, 'utf8'); } catch { continue; }
        for (const line of content.split(/\r?\n/)) {
            const t = line.trim();
            if (!t) continue;
            let e: LedgerEntry;
            try { e = JSON.parse(t) as LedgerEntry; } catch { continue; }
            if (typeof e.prompt === 'string' && e.prompt.trim()) prompts.set(e.id, e);
            else if (typeof e.response === 'string' && e.response.trim()) responses.set(e.id, e);
        }
    }

    const docs: IndexedDoc[] = [];
    for (const [id, p] of prompts) {
        const r = responses.get(`${id}-r`);
        const text = [p.prompt?.trim(), r?.response?.trim()].filter(Boolean).join('\n\n');
        const title = (p.prompt ?? '').trim().replace(/\s+/g, ' ').slice(0, 80) || p.timestamp;
        docs.push({
            id,
            url: `harmony-history://prompt/${id}.md`,
            title,
            text,
            tier: 'content',
            retrieved: (p.timestamp ?? '').slice(0, 10),
            domain: CHAT_DOMAIN,
        });
    }
    return docs;
}

export async function searchChatHistory(query: string, maxResults = 8): Promise<ScoredDoc[]> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return [];
    const docs = await loadChatLedgerDocs(root);
    return searchDocs(query, docs, maxResults);
}

interface RecallInput {
    query: string;
    maxResults?: number;
}

class ChatRecallTool implements vscode.LanguageModelTool<RecallInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<RecallInput>) {
        const query = options.input.query?.trim();
        if (!query) return textResult('error: missing argument: query');
        const maxResults = Math.min(Math.max(options.input.maxResults ?? 8, 1), 25);
        try {
            const hits = await searchChatHistory(query, maxResults);
            if (!hits.length) return textResult('No matching turns found in this workspace chat history.');
            const lines = hits.map((h, i) => {
                const d = h.doc;
                const body = (d.text ?? '').trim();
                const snippet = body.length > 400 ? body.slice(0, 400) + '…' : body;
                return `${i + 1}. [${d.retrieved || 'unknown date'}] ${d.title}\n   ${snippet}\n   score=${h.score.toFixed(3)} · ${d.url}`;
            });
            return textResult(lines.join('\n'));
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<RecallInput>) {
        return { invocationMessage: `Recalling chat history: ${options.input.query}` };
    }
}

export function registerChatRecallTool(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_recall_chat', new ChatRecallTool()),
    );
}
