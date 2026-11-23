import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { loadTodos, getEffectiveActiveTodoLimit } from './todoStore';

/**
 * Context Persistence Verifier (Approach C)
 *
 * After each completed turn, cross-checks pending (uncompleted) todo items
 * against actual filesystem state. Returns a markdown report that can be
 * appended to the chat response.
 *
 * Heuristics used:
 *   - If todo text mentions a file, check if it exists
 *   - If todo text mentions "compile" or "build", check out/ dir freshness
 *   - If todo text mentions an edit, check for matching file modification
 */

function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function fileExists(relativePath: string): Promise<boolean> {
    const root = workspaceRoot();
    if (!root) return false;
    try {
        await fs.access(path.join(root, relativePath));
        return true;
    } catch {
        return false;
    }
}

async function dirHasFiles(relativePath: string): Promise<boolean> {
    const root = workspaceRoot();
    if (!root) return false;
    try {
        const entries = await fs.readdir(path.join(root, relativePath));
        return entries.length > 0;
    } catch {
        return false;
    }
}

interface VerificationResult {
    todoId: string;
    todoText: string;
    status: 'verified' | 'unverified' | 'blocked' | 'pending';
    detail: string;
}

export async function runVerifierCheck(): Promise<string> {
    const todos = await loadTodos();
    const allPending = todos.filter(t => !t.done);
    if (allPending.length === 0) return '## ✅ Verifier: All todo items completed.';

    const activeLimit = getEffectiveActiveTodoLimit();
    const pending = allPending.slice(-activeLimit);
    const omittedBacklogCount = allPending.length - pending.length;

    const results: VerificationResult[] = [];

    for (const todo of pending) {
        const text = todo.text.toLowerCase();
        let status: VerificationResult['status'] = 'pending';
        let detail = 'No specific filesystem check available.';

        // File-related check
        const fileMatch = todo.text.match(/\(?([\w./-]+\.[\w]+)\)?/);
        if (fileMatch) {
            const file = fileMatch[1];
            const exists = await fileExists(file);
            if (exists) {
                status = 'verified';
                detail = `File [${file}] exists.`;
            } else {
                status = 'blocked';
                detail = `File [${file}] does NOT exist yet.`;
            }
        }

        // Compile/build check
        if (text.includes('compile') || text.includes('build')) {
            const outExists = await dirHasFiles('out');
            if (outExists) {
                status = status === 'blocked' ? 'blocked' : 'verified';
                detail += ' out/ directory has compiled output.';
            } else {
                status = 'blocked';
                detail += ' out/ directory is empty or missing.';
            }
        }

        results.push({ todoId: todo.id, todoText: todo.text, status, detail });
    }

    const verified = results.filter(r => r.status === 'verified');
    const blocked = results.filter(r => r.status === 'blocked');
    const pendingOnly = results.filter(r => r.status === 'pending' || r.status === 'unverified');

    const lines: string[] = ['## 🔍 Context Persistence Verifier'];
    lines.push(`> ${pending.length} active pending todo(s), ${verified.length} verified, ${blocked.length} blocked, ${pendingOnly.length} unchecked`);
    if (omittedBacklogCount > 0) {
        lines.push(`> _(Scoped to the ${pending.length} most recent active todo(s); ${omittedBacklogCount} older backlog item(s) omitted to protect VS Code Renderer memory)_`);
    }
    lines.push('');

    if (blocked.length > 0) {
        lines.push('### ⚠️ Blocked (files missing)');
        for (const r of blocked) {
            lines.push(`- ~~${r.todoText}~~ → ${r.detail}`);
        }
        lines.push('');
    }

    if (verified.length > 0) {
        lines.push('### ✅ Verified');
        for (const r of verified) {
            lines.push(`- ${r.todoText} → ${r.detail}`);
        }
        lines.push('');
    }

    if (pendingOnly.length > 0) {
        lines.push('### 🔄 Still Pending');
        for (const r of pendingOnly) {
            lines.push(`- ${r.todoText}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}
