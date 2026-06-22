import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Workspace-scoped, persistent steering list.
 *
 * Harmony uses harmony_todo to externalize a plan: write the steps,
 * then check them off as she completes them. The sidebar mirrors
 * the live state so the user can see what she's doing.
 *
 * Persistence: .harmony/todo.json inside the workspace folder.
 * If no workspace is open, todos live only in memory for the session.
 */

export interface TodoItem {
    id: string;
    text: string;
    done: boolean;
    created: string;
    completed?: string;
}

let inMemoryFallback: TodoItem[] = [];
const listeners = new Set<() => void>();

export function onTodoChange(cb: () => void): vscode.Disposable {
    listeners.add(cb);
    return new vscode.Disposable(() => listeners.delete(cb));
}

function notify() {
    for (const cb of listeners) {
        try { cb(); } catch { /* ignore */ }
    }
}

function todoFileUri(): vscode.Uri | null {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return null;
    return vscode.Uri.joinPath(ws.uri, '.harmony', 'todo.json');
}

async function ensureDir(file: vscode.Uri): Promise<void> {
    const dir = vscode.Uri.joinPath(file, '..');
    try { await vscode.workspace.fs.createDirectory(dir); } catch { /* ignore */ }
}

export async function loadTodos(): Promise<TodoItem[]> {
    const file = todoFileUri();
    if (!file) return [...inMemoryFallback];
    try {
        const buf = await vscode.workspace.fs.readFile(file);
        const text = new TextDecoder('utf-8').decode(buf);
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function saveTodos(items: TodoItem[]): Promise<void> {
    const file = todoFileUri();
    if (!file) {
        inMemoryFallback = [...items];
        notify();
        return;
    }
    await ensureDir(file);
    const data = new TextEncoder().encode(JSON.stringify(items, null, 2));
    await vscode.workspace.fs.writeFile(file, data);
    notify();
}

function newId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export async function addTodos(texts: string[]): Promise<TodoItem[]> {
    const items = await loadTodos();
    const now = new Date().toISOString();
    for (const t of texts) {
        const trimmed = t.trim();
        if (!trimmed) continue;
        items.push({ id: newId(), text: trimmed, done: false, created: now });
    }
    await saveTodos(items);
    return items;
}

export async function checkTodo(id: string, done = true): Promise<TodoItem[]> {
    const items = await loadTodos();
    for (const it of items) {
        if (it.id === id) {
            it.done = done;
            it.completed = done ? new Date().toISOString() : undefined;
        }
    }
    await saveTodos(items);
    return items;
}

export async function removeTodo(id: string): Promise<TodoItem[]> {
    const items = (await loadTodos()).filter(it => it.id !== id);
    await saveTodos(items);
    return items;
}

export async function clearTodos(scope: 'all' | 'done' = 'all'): Promise<TodoItem[]> {
    const items = await loadTodos();
    const kept = scope === 'done' ? items.filter(it => !it.done) : [];
    await saveTodos(kept);
    return kept;
}

export function formatTodos(items: TodoItem[]): string {
    if (items.length === 0) return '(no items)';
    return items
        .map((it, i) => `${i + 1}. [${it.done ? 'x' : ' '}] ${it.text}  \u2014 id:${it.id}`)
        .join('\n');
}

// ── Context Persistence: Batch Management (Approach D) ──

function activeBatchIndexKey(): string {
    const ws = vscode.workspace.workspaceFolders?.[0];
    return ws ? `harmony.activeBatchIndex_${ws.uri.fsPath}` : 'harmony.activeBatchIndex';
}

export function getActiveBatchSize(): number {
    return vscode.workspace.getConfiguration('harmony')
        .get<number>('contextPersistence.activeBatchSize', 5);
}

/**
 * Returns only the current "active batch" of todos.
 * Older pending items wait until the current batch is cleared.
 */
export async function getActiveTodos(): Promise<TodoItem[]> {
    const all = await loadTodos();
    const pending = all.filter(t => !t.done);
    const batchSize = getActiveBatchSize();
    if (pending.length <= batchSize) return pending;
    // Return the oldest N pending items as the active batch
    return pending.slice(0, batchSize);
}

/**
 * Archives all completed (done) todos to a separate file,
 * keeping the main todo.json lean.
 */
export async function archiveCompletedTodos(): Promise<{ archived: number; kept: number }> {
    const all = await loadTodos();
    const done = all.filter(t => t.done);
    const kept = all.filter(t => !t.done);
    if (done.length === 0) return { archived: 0, kept: kept.length };

    // Append completed to archive
    const file = todoFileUri();
    if (file) {
        const archiveUri = vscode.Uri.file(path.join(path.dirname(file.fsPath), 'todos-archive.json'));
        try {
            let archive: TodoItem[] = [];
            try {
                const buf = await vscode.workspace.fs.readFile(archiveUri);
                archive = JSON.parse(new TextDecoder('utf-8').decode(buf));
            } catch { /* archive doesn't exist yet */ }
            archive.push(...done);
            const data = new TextEncoder().encode(JSON.stringify(archive, null, 2));
            await vscode.workspace.fs.writeFile(archiveUri, data);
        } catch { /* skip archive write failures */ }
    }

    await saveTodos(kept);
    return { archived: done.length, kept: kept.length };
}
