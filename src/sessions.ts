import * as vscode from 'vscode';

/**
 * Workspace-scoped chat session persistence.
 *
 * A "session" is a snapshot of recent prompts/responses the user wants to
 * resume later. Stored in .harmony/sessions/{name}.json. Free-form, no
 * schema validation \u2014 just user-readable JSON they can hand-edit.
 *
 * NOTE: this is NOT live conversation history (VS Code chat owns that).
 * It's a "save these turns under a name so I can re-prime later" tool.
 */

export interface SessionTurn {
    role: 'user' | 'assistant';
    text: string;
    ts: string;
}

export interface SessionFile {
    name: string;
    created: string;
    updated: string;
    turns: SessionTurn[];
    notes?: string;
}

function sessionsDir(): vscode.Uri | null {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return null;
    return vscode.Uri.joinPath(ws.uri, '.harmony', 'sessions');
}

async function ensureDir(dir: vscode.Uri): Promise<void> {
    try { await vscode.workspace.fs.createDirectory(dir); } catch { /* ignore */ }
}

function sanitize(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60) || 'session';
}

export async function listSessions(): Promise<string[]> {
    const dir = sessionsDir();
    if (!dir) return [];
    try {
        const entries = await vscode.workspace.fs.readDirectory(dir);
        return entries
            .filter(([n, t]) => t === vscode.FileType.File && n.endsWith('.json'))
            .map(([n]) => n.replace(/\.json$/, ''))
            .sort();
    } catch {
        return [];
    }
}

export async function saveSession(name: string, turns: SessionTurn[], notes?: string): Promise<string> {
    const dir = sessionsDir();
    if (!dir) throw new Error('No workspace open \u2014 cannot save session.');
    await ensureDir(dir);
    const safe = sanitize(name);
    const file = vscode.Uri.joinPath(dir, `${safe}.json`);
    let existing: SessionFile | null = null;
    try {
        const buf = await vscode.workspace.fs.readFile(file);
        existing = JSON.parse(new TextDecoder('utf-8').decode(buf));
    } catch { /* new file */ }
    const now = new Date().toISOString();
    const data: SessionFile = {
        name: safe,
        created: existing?.created ?? now,
        updated: now,
        turns,
        notes: notes ?? existing?.notes
    };
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(JSON.stringify(data, null, 2)));
    return safe;
}

export async function loadSession(name: string): Promise<SessionFile | null> {
    const dir = sessionsDir();
    if (!dir) return null;
    const safe = sanitize(name);
    const file = vscode.Uri.joinPath(dir, `${safe}.json`);
    try {
        const buf = await vscode.workspace.fs.readFile(file);
        return JSON.parse(new TextDecoder('utf-8').decode(buf));
    } catch {
        return null;
    }
}

export async function deleteSession(name: string): Promise<boolean> {
    const dir = sessionsDir();
    if (!dir) return false;
    const safe = sanitize(name);
    const file = vscode.Uri.joinPath(dir, `${safe}.json`);
    try {
        await vscode.workspace.fs.delete(file);
        return true;
    } catch {
        return false;
    }
}

export function formatSessionPreamble(s: SessionFile): string {
    const lines: string[] = [
        `[Resumed session: "${s.name}", saved ${s.updated}]`,
    ];
    if (s.notes) lines.push(`Notes: ${s.notes}`);
    lines.push('');
    lines.push('Prior conversation:');
    for (const t of s.turns) {
        lines.push(`${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`);
        lines.push('');
    }
    const result = lines.join('\n');
    const MAX_SESSION_OUTPUT_CHARS = 8000;
    if (result.length > MAX_SESSION_OUTPUT_CHARS) {
        let output = '';
        const headerEnd = 2 + (s.notes ? 1 : 0) + 2;
        for (let i = 0; i < headerEnd && i < lines.length; i++) {
            output += lines[i] + '\n';
        }
        const turnLines: string[] = [];
        for (let i = lines.length - 1; i >= headerEnd; i--) {
            const candidate = lines[i] + '\n';
            if (output.length + candidate.length + turnLines.join('').length > MAX_SESSION_OUTPUT_CHARS - 100) break;
            turnLines.unshift(lines[i]);
        }
        output += turnLines.join('\n');
        if (output.length < result.length) {
            output += '\n\n[Session preamble trimmed to prevent context overflow]';
        }
        return output;
    }
    return result;
}
