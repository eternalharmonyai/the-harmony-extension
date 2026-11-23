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

export const DEFAULT_ACTIVE_TODO_WINDOW = 11;
export const RECENT_COMPLETED_KEEP = 4;

async function appendToTodoArchive(toArchive: TodoItem[]): Promise<boolean> {
    if (toArchive.length === 0) return true;
    const file = todoFileUri();
    if (!file) return true;
    const archiveUri = vscode.Uri.file(path.join(path.dirname(file.fsPath), 'todos-archive.json'));
    try {
        let archive: TodoItem[] = [];
        try {
            const buf = await vscode.workspace.fs.readFile(archiveUri);
            const parsed = JSON.parse(new TextDecoder('utf-8').decode(buf));
            if (Array.isArray(parsed)) archive = parsed;
        } catch { /* archive doesn't exist yet */ }
        const seenIds = new Set(archive.map(it => it.id));
        for (const item of toArchive) {
            if (!seenIds.has(item.id)) {
                archive.push(item);
                seenIds.add(item.id);
            }
        }
        const data = new TextEncoder().encode(JSON.stringify(archive, null, 2));
        await vscode.workspace.fs.writeFile(archiveUri, data);
        return true;
    } catch {
        // Never discard completed items from todo.json if archive write fails (Rule 3)
        return false;
    }
}

async function saveTodosWithAutoArchive(items: TodoItem[]): Promise<TodoItem[]> {
    const done = items.filter(it => it.done);
    if (done.length <= RECENT_COMPLETED_KEEP) {
        await saveTodos(items);
        return items;
    }
    const overflowDone = done.slice(0, done.length - RECENT_COMPLETED_KEEP);
    const archivedOk = await appendToTodoArchive(overflowDone);
    if (!archivedOk) {
        await saveTodos(items);
        return items;
    }
    const overflowIds = new Set(overflowDone.map(it => it.id));
    const kept = items.filter(it => !overflowIds.has(it.id));
    await saveTodos(kept);
    return kept;
}

let todoMutationChain: Promise<unknown> = Promise.resolve();

function withTodoLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = todoMutationChain.then(fn, fn);
    todoMutationChain = next.then(() => undefined, () => undefined);
    return next;
}

export async function addTodos(texts: string[]): Promise<TodoItem[]> {
    return withTodoLock(async () => {
        const items = await loadTodos();
        const now = new Date().toISOString();
        for (const t of texts) {
            const trimmed = t.trim();
            if (!trimmed) continue;
            items.push({ id: newId(), text: trimmed, done: false, created: now });
        }
        return saveTodosWithAutoArchive(items);
    });
}

export async function checkTodo(id: string, done = true): Promise<TodoItem[]> {
    return withTodoLock(async () => {
        const items = await loadTodos();
        for (const it of items) {
            if (it.id === id) {
                it.done = done;
                it.completed = done ? new Date().toISOString() : undefined;
            }
        }
        return saveTodosWithAutoArchive(items);
    });
}

export async function removeTodo(id: string): Promise<TodoItem[]> {
    return withTodoLock(async () => {
        const items = (await loadTodos()).filter(it => it.id !== id);
        await saveTodos(items);
        return items;
    });
}

export async function clearTodos(scope: 'all' | 'done' = 'all'): Promise<TodoItem[]> {
    return withTodoLock(async () => {
        const items = await loadTodos();
        const kept = scope === 'done' ? items.filter(it => !it.done) : [];
        await saveTodos(kept);
        return kept;
    });
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

export function getEffectiveActiveTodoLimit(): number {
    return Math.max(DEFAULT_ACTIVE_TODO_WINDOW, getActiveBatchSize());
}

/**
 * Formats a bounded active window of todos (most recent active + recent completed)
 * with an explicit AGENTS.md §6 disclosure line whenever older items are omitted,
 * preventing multi-KB repeated Chat tool cards from bloating the VS Code Renderer heap.
 */
export function formatActiveWindowTodos(
    items: TodoItem[],
    maxActive = getEffectiveActiveTodoLimit(),
    maxRecentDone = RECENT_COMPLETED_KEEP
): string {
    if (items.length === 0) return '(no items)';
    const pending = items.filter(t => !t.done);
    const done = items.filter(t => t.done);
    const keptPending = pending.slice(-Math.max(1, maxActive));
    const keptDone = done.slice(-Math.max(0, maxRecentDone));
    const keptIds = new Set<string>([
        ...keptPending.map(t => t.id),
        ...keptDone.map(t => t.id),
    ]);
    const windowed = items.filter(it => keptIds.has(it.id));
    const lines = windowed.map(
        (it, idx) => `${idx + 1}. [${it.done ? 'x' : ' '}] ${it.text}  \u2014 id:${it.id}`
    );
    const omittedPending = pending.length - keptPending.length;
    const omittedDone = done.length - keptDone.length;
    if (omittedPending > 0 || omittedDone > 0) {
        const parts: string[] = [];
        if (omittedPending > 0) parts.push(`${omittedPending} older pending`);
        if (omittedDone > 0) parts.push(`${omittedDone} older completed`);
        lines.push(
            `\u2026 [Active window: showing ${windowed.length} of ${items.length} todo(s); ` +
            `${parts.join(' + ')} omitted from chat output to protect VS Code Renderer memory. ` +
            `Completed items auto-archive to .harmony/todos-archive.json]`
        );
    }
    return lines.join('\n');
}

/**
 * Returns only the current "active batch" of todos (most recent pending items).
 */
export async function getActiveTodos(): Promise<TodoItem[]> {
    const all = await loadTodos();
    const pending = all.filter(t => !t.done);
    const limit = getEffectiveActiveTodoLimit();
    if (pending.length <= limit) return pending;
    return pending.slice(-limit);
}

/**
 * Archives all completed (done) todos to a separate file,
 * keeping the main todo.json lean.
 */
export async function archiveCompletedTodos(): Promise<{ archived: number; kept: number }> {
    return withTodoLock(async () => {
        const all = await loadTodos();
        const done = all.filter(t => t.done);
        const kept = all.filter(t => !t.done);
        if (done.length === 0) return { archived: 0, kept: kept.length };

        const archivedOk = await appendToTodoArchive(done);
        if (!archivedOk) return { archived: 0, kept: all.length };

        await saveTodos(kept);
        return { archived: done.length, kept: kept.length };
    });
}
