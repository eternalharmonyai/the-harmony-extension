import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

// ── ContextManager: Eternal Music Library ────────────────────────────────
// Motive Files store compressed reasoning in tiny (2-5KB) immutable records.
// Content-addressed, hash-chained, workspace-scoped.

export interface MotiveFile {
    id: string;           // SHA256 of content
    prev_hash?: string;   // Links to previous motive in chain
    summary: string;      // Compressed reasoning (2-5KB)
    timestamp: number;
    tokens_in?: number;   // Estimated input tokens summarized
    source: string;       // e.g. 'auto-summarizer', 'reflective-resonance', 'worker-output'
}

function workspaceHash(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'default';
    return crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
}

function motivesDir(): string | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return undefined;
    return path.join(root, '.harmony', 'context', 'motives', workspaceHash());
}

async function ensureMotivesDir(): Promise<string> {
    const dir = motivesDir();
    if (!dir) throw new Error('no workspace open');
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

/** Store a new Motive File. Returns the motive ID (SHA256 hash). */
export async function storeMotive(summary: string, source: string, tokensIn?: number, prevHash?: string): Promise<string> {
    const dir = await ensureMotivesDir();
    const timestamp = Date.now();
    const content = JSON.stringify({ summary, source, timestamp, prev_hash: prevHash, tokens_in: tokensIn });
    const id = crypto.createHash('sha256').update(content).digest('hex').slice(0, 32);
    const motive: MotiveFile = {
        id,
        prev_hash: prevHash,
        summary: summary.slice(0, 5000),
        timestamp,
        tokens_in: tokensIn,
        source,
    };
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(motive, null, 2), 'utf8');
    return id;
}

/** Retrieve a Motive File by ID. */
export async function getMotive(id: string): Promise<MotiveFile | null> {
    const dir = motivesDir();
    if (!dir) return null;
    try {
        const buf = await fs.readFile(path.join(dir, `${id}.json`), 'utf8');
        return JSON.parse(buf);
    } catch {
        return null;
    }
}

/** List all Motive Files, newest first. */
export async function listMotives(limit = 50): Promise<MotiveFile[]> {
    const dir = motivesDir();
    if (!dir) return [];
    try {
        const files = await fs.readdir(dir);
        const motives: MotiveFile[] = [];
        for (const f of files) {
            if (!f.endsWith('.json')) continue;
            try {
                const buf = await fs.readFile(path.join(dir, f), 'utf8');
                motives.push(JSON.parse(buf));
            } catch { /* skip corrupt */ }
        }
        return motives.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    } catch {
        return [];
    }
}

/** Simple keyword search across stored motives. */
export async function searchMotives(query: string, limit = 10): Promise<MotiveFile[]> {
    const all = await listMotives(200);
    const q = query.toLowerCase();
    return all.filter(m => m.summary.toLowerCase().includes(q)).slice(0, limit);
}

/** Get the latest motive (for chain linking). */
export async function latestMotive(): Promise<MotiveFile | null> {
    const all = await listMotives(1);
    return all[0] ?? null;
}

/** Format motives for display. */
export function formatMotives(motives: MotiveFile[]): string {
    if (motives.length === 0) return '📚 No motives stored yet.';
    const lines = [`📚 **Context Library** — ${motives.length} motive(s)`, ''];
    for (const m of motives) {
        const ts = new Date(m.timestamp).toISOString().slice(0, 16).replace('T', ' ');
        const size = m.summary.length;
        lines.push(`- **[${ts}]** ${m.source} (${size} chars${m.tokens_in ? `, ~${m.tokens_in} tokens in` : ''})`);
    }
    return lines.join('\n');
}

/** Estimate storage: each motive is roughly 2-5KB. 1000 motives ≈ 3-5MB. */
export function storageEstimate(): { count: number; estimatedKB: number } {
    // We need the actual count; this is a placeholder.
    return { count: 0, estimatedKB: 0 };
}

/** Summarize text into a Motive File using Gemini Flash. Chain-links to previous motive. */
export async function summarizeToMotive(text: string, secrets: vscode.SecretStorage, source = 'auto-summarizer'): Promise<string | null> {
    if (!text || text.length < 100) return null;
    try {
        const { consult } = await import('./providers');
        const prev = await latestMotive();
        const prompt = `Summarize this conversation fragment into a SINGLE paragraph (max 300 words). Focus on key decisions, technical insights, and action items. Strip pleasantries. Keep only what matters for future context:\n\n${text.slice(0, 8000)}`;
        // Use a no-op cancellation token — creating a new CancellationTokenSource here
        // would leak without proper disposal. The summarizer runs fast and doesn't need cancellation.
        const r = await consult(secrets, { provider: 'gemini', tier: 'light', question: prompt, system: 'You compress conversation context into dense Motive Files for an Eternal Concert Hall. Be ruthlessly concise. Output only the summary paragraph.', maxTokens: 512 }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) });
        const id = await storeMotive(r.text.trim(), source, Math.ceil(text.length / 4), prev?.id);
        return id;
    } catch {
        return null;
    }
}
