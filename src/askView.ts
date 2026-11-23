import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LanguageManager } from './languageManager';
import { createBoundedOutputChannel, type BoundedOutputChannel } from './rendererShield';

export type HarmonyAskMode = 'explore' | 'decide';

export interface HarmonyAskTextParts {
    header?: string;
    mode?: HarmonyAskMode;
    thought?: string;
    message?: string;
    question: string;
}

/**
 * Format structured Ask fields into visible prompt text so `mode` and `thought`
 * are surfaced cleanly instead of silently dropped when models use Flow-State.
 */
export function formatAskQuestionText(input: HarmonyAskTextParts): string {
    const modeTag = input.mode === 'explore'
        ? '🌸 Explore'
        : input.mode === 'decide'
            ? '⚖️ Decide'
            : undefined;
    const headerText = typeof input.header === 'string' ? input.header.trim() : '';
    const titleLine = [modeTag, headerText].filter(Boolean).join(' — ') || undefined;
    const thoughtText = typeof input.thought === 'string' ? input.thought.trim() : '';
    const thoughtBlock = thoughtText ? `💭 ${thoughtText}` : undefined;
    const questionText = typeof input.question === 'string' ? input.question.trim() : '';
    const messageText = typeof input.message === 'string' ? input.message.trim() : '';
    return [titleLine, thoughtBlock, questionText, messageText].filter(Boolean).join('\n\n');
}

export interface HarmonyAskOption {
    label: string;
    description?: string;
    recommended?: boolean;
}

export interface HarmonyAskOptions {
    question: string;
    options?: Array<string | HarmonyAskOption>;
    multiline?: boolean;
    allowFreeformInput?: boolean;
    multiSelect?: boolean;
    /** Show a 'Ready' checkbox that both parties can use to signal readiness to proceed. */
    readyCheckbox?: boolean;
    /** Custom label for the ready checkbox. Defaults to '✅ Ready — proceed when you are too'. */
    readyLabel?: string;
}

const ASK_VIEW_TYPE = 'harmony.ask';
const ASK_READY_TIMEOUT_MS = 30000;

/**
 * Failure reporting for the Ask surface.
 *
 * AGENTS.md rule #6: a guard that fires must reach a surface a human can read,
 * never only a console log that extension hosts do not capture. This channel is
 * deliberately separate from chatParticipant's 'Harmony Debug' channel because
 * chatParticipant imports this module — importing it back would be a cycle.
 *
 * Logging must never break the prompt, so both paths are guarded.
 */
let askLogChannel: BoundedOutputChannel | undefined;
function logAskFailure(message: string): void {
    try {
        askLogChannel ??= createBoundedOutputChannel(
            () => vscode.window.createOutputChannel('Harmony Ask'),
            { name: 'Harmony Ask', ignoreDispose: true }
        );
        askLogChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
    } catch { /* logging is best-effort */ }
    try {
        vscode.window.setStatusBarMessage(`Harmony Ask: ${message}`, 8000);
    } catch { /* status bar is best-effort */ }
}

interface NormalizedAskItem {
    id: string;
    batchId: string;
    question: string;
    options: HarmonyAskOption[];
    multiline: boolean;
    allowFreeform: boolean;
    multiSelect: boolean;
    readyCheckbox: boolean;
    readyLabel: string;
    placeholder: string;
}

interface PendingAskBatch {
    batchId: string;
    inputs: HarmonyAskOptions[];
    itemIds: string[];
    token?: vscode.CancellationToken;
    cancelSub?: vscode.Disposable;
    settled: boolean;
    resolve: (answers: Array<string | undefined>) => void;
    reject: (err: Error) => void;
}

interface ActiveAskSession {
    panel: vscode.WebviewPanel;
    ready: boolean;
    readyTimer?: NodeJS.Timeout;
    items: NormalizedAskItem[];
    batches: PendingAskBatch[];
}

let activeAskSession: ActiveAskSession | undefined;
let askSeq = 0;

/**
 * Ask the user a single question via the Harmony Ask webview panel (with automatic
 * queue coalescing if a panel is already open, and QuickPick fallback if the
 * webview host fails to report ready).
 */
export async function showHarmonyAsk(input: HarmonyAskOptions, token?: vscode.CancellationToken): Promise<string | undefined> {
    const answers = await showHarmonyAskBatch([input], token);
    return answers[0];
}

/**
 * Persist every answered Ask batch to `.harmony/ask-answers/` BEFORE returning
 * to the LLM turn so a broken network stream, host reload, or turn cancellation
 * can never lose the user's words again.
 */
export function persistHarmonyAskReceipt(
    inputs: HarmonyAskOptions[],
    answers: string[],
    workspaceRootOverride?: string
): { ok: boolean; jsonlPath?: string; latestPath?: string; error?: string } {
    const root = typeof workspaceRootOverride === 'string' && workspaceRootOverride.trim()
        ? workspaceRootOverride.trim()
        : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
        return { ok: false, error: 'no workspace folder open' };
    }
    try {
        const dir = path.join(root, '.harmony', 'ask-answers');
        fs.mkdirSync(dir, { recursive: true });
        const entry = {
            timestamp: new Date().toISOString(),
            count: answers.length,
            items: inputs.map((item, idx) => ({
                question: item.question,
                answer: answers[idx] ?? '',
                multiSelect: !!item.multiSelect,
                multiline: !!item.multiline,
            })),
        };
        const jsonlPath = path.join(dir, 'answers.jsonl');
        const latestPath = path.join(dir, 'latest.json');
        fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n', 'utf8');
        fs.writeFileSync(latestPath, JSON.stringify(entry, null, 2), 'utf8');
        return { ok: true, jsonlPath, latestPath };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logAskFailure(`Failed to persist Ask answer receipt to .harmony/ask-answers: ${msg}`);
        return { ok: false, error: msg };
    }
}

/**
 * Ask the user one or more questions in a unified Harmony Ask queue with
 * Back/Next navigation, clickable question pills, and draft preservation.
 */
export async function showHarmonyAskBatch(inputs: HarmonyAskOptions[], token?: vscode.CancellationToken): Promise<Array<string | undefined>> {
    if (!Array.isArray(inputs) || inputs.length === 0) return [];
    if (token?.isCancellationRequested) return inputs.map(() => undefined);
    try {
        const webviewAnswers = await enqueueHarmonyAskWebviewBatch(inputs, token);
        if (webviewAnswers.length > 0 && webviewAnswers.every((a): a is string => typeof a === 'string')) {
            persistHarmonyAskReceipt(inputs, webviewAnswers);
        }
        return webviewAnswers;
    } catch (err) {
        if (token?.isCancellationRequested) return inputs.map(() => undefined);
        // This error used to be discarded unread, so a failed panel was
        // indistinguishable from a cancelled one. Name it instead (rule #6).
        logAskFailure(
            'Ask panel did not become ready; using the native prompt instead. Cause: ' +
            (err instanceof Error ? err.message : String(err))
        );
        const out: string[] = [];
        for (const item of inputs) {
            const ans = await showHarmonyAskQuickInput(item, token);
            if (ans === undefined) return inputs.map(() => undefined);
            out.push(ans);
        }
        if (out.length > 0) {
            persistHarmonyAskReceipt(inputs, out);
        }
        return out;
    }
}

async function showHarmonyAskQuickInput(input: HarmonyAskOptions, token?: vscode.CancellationToken): Promise<string | undefined> {
    const options = normalizeOptions(input.options);
    if (options.length > 0) {
        const items: vscode.QuickPickItem[] = options.map(o => ({
            label: o.label,
            description: o.recommended ? '★ Recommended' : undefined,
            detail: o.description,
        }));
        if (input.allowFreeformInput !== false) {
            items.push({ label: '✏️ Type a custom answer...', description: 'Freeform input' });
        }
        const picked = await vscode.window.showQuickPick(items, {
            title: 'Harmony Ask',
            placeHolder: input.question.replace(/\s+/g, ' ').trim(),
            canPickMany: !!input.multiSelect,
            ignoreFocusOut: true,
        }, token);
        if (!picked) return undefined;
        const pickedArray = Array.isArray(picked) ? picked : [picked];
        const wantsCustom = pickedArray.some(p => p.label === '✏️ Type a custom answer...');
        const chosenLabels = pickedArray
            .filter(p => p.label !== '✏️ Type a custom answer...')
            .map(p => p.label);
        if (wantsCustom) {
            const custom = await vscode.window.showInputBox({
                title: 'Harmony Ask',
                prompt: input.question.replace(/\s+/g, ' ').trim(),
                ignoreFocusOut: true,
            }, token);
            if (custom && chosenLabels.length > 0) return `${chosenLabels.join('\n')}\n\n${custom.trim()}`;
            return custom?.trim() || (chosenLabels.length > 0 ? chosenLabels.join('\n') : undefined);
        }
        return chosenLabels.join('\n') || undefined;
    }
    const text = await vscode.window.showInputBox({
        title: 'Harmony Ask',
        prompt: input.question.replace(/\s+/g, ' ').trim(),
        ignoreFocusOut: true,
    }, token);
    return text?.trim() || undefined;
}

function normalizeAskItem(input: HarmonyAskOptions, batchId: string): NormalizedAskItem {
    const lm = LanguageManager.getInstance();
    const options = normalizeOptions(input.options);
    const id = `ask_${++askSeq}_${Date.now()}`;
    return {
        id,
        batchId,
        question: input.question,
        options,
        multiline: !!input.multiline,
        allowFreeform: input.allowFreeformInput !== false,
        multiSelect: !!input.multiSelect,
        readyCheckbox: !!input.readyCheckbox,
        readyLabel: input.readyLabel || lm.getString('ask.readyLabel'),
        placeholder: (input.multiline || options.length > 0)
            ? lm.getString('ask.placeholderWithOptions')
            : lm.getString('ask.placeholder'),
    };
}

function formatSingleAskAnswer(raw: any): string | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const selected = Array.isArray(raw.selected)
        ? raw.selected.map((v: unknown) => String(v).trim()).filter(Boolean).join('\n')
        : typeof raw.selected === 'string' ? raw.selected.trim() : '';
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    const ready = raw.ready === true ? '\n\n✅ Ready' : '';
    if (selected && text) return `${selected}\n\n${text}${ready}`;
    if (selected) return `${selected}${ready}`;
    return text || ready || undefined;
}

function enqueueHarmonyAskWebviewBatch(inputs: HarmonyAskOptions[], token?: vscode.CancellationToken): Promise<Array<string | undefined>> {
    return new Promise((resolve, reject) => {
        const batchId = `batch_${++askSeq}_${Date.now()}`;
        const newItems = inputs.map(inp => normalizeAskItem(inp, batchId));
        const batch: PendingAskBatch = {
            batchId,
            inputs,
            itemIds: newItems.map(i => i.id),
            token,
            settled: false,
            resolve,
            reject,
        };

        if (activeAskSession) {
            const session = activeAskSession;
            session.items.push(...newItems);
            session.batches.push(batch);
            session.panel.title = session.items.length > 1
                ? `Harmony Ask (${session.items.length} in Queue)`
                : 'Harmony Ask';
            try {
                session.panel.reveal(vscode.ViewColumn.Beside, true);
            } catch { /* ignore */ }
            if (session.ready) {
                session.panel.webview.postMessage({
                    type: 'queueAppend',
                    items: newItems,
                });
            }
            batch.cancelSub = token?.onCancellationRequested(() => {
                cancelBatchInSession(session, batchId);
            });
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ASK_VIEW_TYPE,
            newItems.length > 1 ? `Harmony Ask (${newItems.length} in Queue)` : 'Harmony Ask',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true }
        );

        const session: ActiveAskSession = {
            panel,
            ready: false,
            items: [...newItems],
            batches: [batch],
        };
        activeAskSession = session;

        batch.cancelSub = token?.onCancellationRequested(() => {
            cancelBatchInSession(session, batchId);
        });

        session.readyTimer = setTimeout(() => {
            if (!session.ready && activeAskSession === session) {
                failEntireSession(session, new Error('Harmony Ask webview did not report ready.'));
            }
        }, ASK_READY_TIMEOUT_MS);

        panel.onDidDispose(() => {
            if (activeAskSession === session) {
                activeAskSession = undefined;
            }
            if (session.readyTimer) clearTimeout(session.readyTimer);
            for (const b of session.batches) {
                b.cancelSub?.dispose();
                if (!b.settled) {
                    b.settled = true;
                    b.resolve(b.itemIds.map(() => undefined));
                }
            }
        });

        panel.webview.onDidReceiveMessage((msg) => {
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'ready') {
                session.ready = true;
                if (session.readyTimer) clearTimeout(session.readyTimer);
                session.panel.webview.postMessage({
                    type: 'queueInit',
                    items: session.items,
                });
                return;
            }
            if (msg.type === 'renderFailed') {
                // The panel is alive but its UI threw. That used to be silent and
                // looked identical to the host from the outside.
                logAskFailure('Ask panel script failed to render: ' + String(msg.message ?? 'unknown error'));
                return;
            }
            if (msg.type === 'cancel') {
                if (activeAskSession === session) activeAskSession = undefined;
                for (const b of session.batches) {
                    b.cancelSub?.dispose();
                    if (!b.settled) {
                        b.settled = true;
                        b.resolve(b.itemIds.map(() => undefined));
                    }
                }
                panel.dispose();
                return;
            }
            if (msg.type === 'answerAll' || msg.type === 'answer') {
                const answersById = new Map<string, string | undefined>();
                if (msg.type === 'answerAll' && msg.answers && typeof msg.answers === 'object') {
                    for (const [itemId, rawAns] of Object.entries(msg.answers)) {
                        answersById.set(itemId, formatSingleAskAnswer(rawAns));
                    }
                } else if (session.items.length > 0) {
                    answersById.set(session.items[0].id, formatSingleAskAnswer(msg));
                }

                if (activeAskSession === session) activeAskSession = undefined;
                for (const b of session.batches) {
                    b.cancelSub?.dispose();
                    if (!b.settled) {
                        b.settled = true;
                        const resolvedAnswers = b.itemIds.map(id => answersById.get(id));
                        b.resolve(resolvedAnswers);
                    }
                }
                panel.dispose();
            }
        });

        const nonce = randomNonce();
        panel.webview.html = renderAskHtml(session.items, nonce);
    });
}

function cancelBatchInSession(session: ActiveAskSession, batchId: string): void {
    const batch = session.batches.find(b => b.batchId === batchId);
    if (!batch || batch.settled) return;
    batch.settled = true;
    batch.cancelSub?.dispose();
    batch.resolve(batch.itemIds.map(() => undefined));
    session.items = session.items.filter(item => item.batchId !== batchId);
    if (session.items.length === 0) {
        if (activeAskSession === session) activeAskSession = undefined;
        session.panel.dispose();
    } else if (session.ready) {
        session.panel.title = session.items.length > 1
            ? `Harmony Ask (${session.items.length} in Queue)`
            : 'Harmony Ask';
        session.panel.webview.postMessage({
            type: 'queueSync',
            items: session.items,
        });
    }
}

function failEntireSession(session: ActiveAskSession, error: Error): void {
    if (activeAskSession === session) activeAskSession = undefined;
    if (session.readyTimer) clearTimeout(session.readyTimer);
    for (const b of session.batches) {
        b.cancelSub?.dispose();
        if (!b.settled) {
            b.settled = true;
            b.reject(error);
        }
    }
    session.panel.dispose();
}

function renderAskHtml(initialItems: NormalizedAskItem[], nonce: string): string {
    const lm = LanguageManager.getInstance();
    const localized = {
        expand: lm.getString('ask.expand'),
        collapse: lm.getString('ask.collapse'),
        answer: lm.getString('ask.answer'),
        cancel: lm.getString('ask.cancel'),
        hint: lm.getString('ask.hint'),
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<title>${escapeHtml(lm.getString('ask.title'))}</title>
<style>
    :root { color-scheme: light dark; }
    body {
        margin: 0;
        padding: 16px;
        box-sizing: border-box;
        height: 100vh;
        display: flex;
        flex-direction: column;
        gap: 12px;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
    }
    .queue-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 6px;
        background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
        border: 1px solid var(--vscode-panel-border, var(--vscode-input-border, rgba(128, 128, 128, 0.25)));
        flex-wrap: wrap;
    }
    .queue-status {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        font-size: 0.92em;
    }
    .queue-badge {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 0.84em;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
    }
    .queue-pills {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
    }
    .queue-pill {
        padding: 3px 9px;
        border-radius: 999px;
        font-size: 0.82em;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        background: transparent;
        color: var(--vscode-foreground);
        cursor: pointer;
    }
    .queue-pill.active {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border-color: var(--vscode-focusBorder);
        font-weight: 600;
    }
    .queue-pill.answered {
        border-color: var(--vscode-testing-iconPassed, #4ec9b0);
    }
    .queue-nav {
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .question {
        font-size: 1.05em;
        line-height: 1.45;
        font-weight: 600;
        white-space: pre-wrap;
    }
    .choices {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .choice {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        padding: 8px;
        border: 1px solid var(--vscode-panel-border, var(--vscode-input-border));
        border-radius: 6px;
        cursor: pointer;
    }
    .choice:hover { background: var(--vscode-list-hoverBackground); }
    .choice.recommended { border-color: var(--vscode-focusBorder); }
    .choice input { margin-top: 2px; }
    .choice .desc { display: block; opacity: 0.72; font-size: 0.88em; margin-top: 2px; }
    textarea {
        width: 100%;
        min-height: 110px;
        flex: 1;
        resize: vertical;
        box-sizing: border-box;
        padding: 10px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, 13px);
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 4px;
    }
    textarea.expanded { min-height: 55vh; }
    textarea:focus {
        outline: 1px solid var(--vscode-focusBorder);
        border-color: var(--vscode-focusBorder);
    }
    .hint { opacity: 0.7; font-size: 0.88em; }
    .actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        align-items: center;
        flex-wrap: wrap;
    }
    button {
        padding: 6px 14px;
        border-radius: 4px;
        border: 1px solid var(--vscode-button-border, transparent);
        cursor: pointer;
        font-size: 0.9em;
    }
    button:disabled {
        opacity: 0.45;
        cursor: default;
    }
    button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button.secondary {
        background: var(--vscode-button-secondaryBackground, transparent);
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    }
    button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
    button.submit-ready {
        background: var(--vscode-testing-iconPassed, #2ea043);
        color: #ffffff;
        font-weight: 600;
    }
    button.submit-ready:hover:not(:disabled) {
        filter: brightness(1.08);
    }
    .nav-divider {
        width: 1px;
        height: 20px;
        background: var(--vscode-panel-border, rgba(128,128,128,0.35));
        margin: 0 4px;
    }
    .spacer { flex: 1; }
    .ready-row {
        display: flex;
        gap: 8px;
        align-items: center;
        padding: 8px 12px;
        border: 1px solid var(--vscode-panel-border, var(--vscode-input-border));
        border-radius: 6px;
        font-size: 0.92em;
        cursor: pointer;
    }
    .ready-row:hover { background: var(--vscode-list-hoverBackground); }
    .ready-row input { margin: 0; cursor: pointer; }
    .hidden { display: none !important; }
</style>
</head>
<body>
    <div class="queue-bar" id="queueBar">
        <div class="queue-status">
            <span id="queueTitle">Question 1 of 1</span>
            <span class="queue-badge" id="queueBadge">1 in queue</span>
        </div>
        <div class="queue-pills" id="queuePills"></div>
        <div class="queue-nav">
            <button class="secondary" id="prevBtn" title="Previous question (Alt+Left)">← Previous</button>
            <button class="secondary" id="nextBtn" title="Next question (Alt+Right)">Next →</button>
        </div>
    </div>
    <div class="question" id="questionText"></div>
    <div class="choices" id="choicesContainer"></div>
    <textarea id="answer" placeholder=""></textarea>
    <div class="hint">${escapeHtml(localized.hint)}</div>
    <label class="ready-row hidden" id="readyRow">
        <input type="checkbox" id="readyCheck">
        <span id="readyLabelText"></span>
    </label>
    <div class="actions">
        <button class="secondary" id="expand">${escapeHtml(localized.expand)}</button>
        <span class="spacer"></span>
        <button class="secondary" id="cancel">${escapeHtml(localized.cancel)}</button>
        <button class="secondary hidden" id="bottomPrevBtn" title="Previous question (Alt+Left)">← Previous</button>
        <button class="primary hidden" id="bottomNextBtn" title="Next question (Alt+Right)">Next →</button>
        <span class="nav-divider hidden" id="bottomNavDivider"></span>
        <button class="primary" id="answerBtn">${escapeHtml(localized.answer)}</button>
    </div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const LOC = ${JSON.stringify(localized)};
let items = ${JSON.stringify(initialItems)};
let currentIndex = 0;
const drafts = {};

const queueTitle = document.getElementById('queueTitle');
const queueBadge = document.getElementById('queueBadge');
const queuePills = document.getElementById('queuePills');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const questionText = document.getElementById('questionText');
const choicesContainer = document.getElementById('choicesContainer');
const answer = document.getElementById('answer');
const readyRow = document.getElementById('readyRow');
const readyCheck = document.getElementById('readyCheck');
const readyLabelText = document.getElementById('readyLabelText');
const expand = document.getElementById('expand');
const cancel = document.getElementById('cancel');
const bottomPrevBtn = document.getElementById('bottomPrevBtn');
const bottomNextBtn = document.getElementById('bottomNextBtn');
const bottomNavDivider = document.getElementById('bottomNavDivider');
const answerBtn = document.getElementById('answerBtn');

function ensureDraft(item, markVisited) {
    if (!item) return { selected: [], text: '', ready: false, visited: false };
    if (!drafts[item.id]) {
        const defaultSelected = (!item.multiSelect && item.options && item.options.length > 0)
            ? [item.options[0].label]
            : [];
        drafts[item.id] = {
            selected: defaultSelected,
            text: '',
            ready: false,
            visited: !!markVisited,
        };
    } else if (markVisited) {
        drafts[item.id].visited = true;
    }
    return drafts[item.id];
}

function isDraftAnswered(item) {
    const d = ensureDraft(item, false);
    return (d.selected && d.selected.length > 0) || (d.text && d.text.trim().length > 0) || !!d.ready;
}

function isDraftReady(item) {
    const d = ensureDraft(item, false);
    return !!d.visited && isDraftAnswered(item);
}

function saveCurrentDraftFromDom() {
    const item = items[currentIndex];
    if (!item) return;
    const prev = ensureDraft(item, true);
    const checked = Array.from(document.querySelectorAll('input[name="choice"]:checked')).map((el) => el.value);
    const textVal = answer && !answer.classList.contains('hidden') ? answer.value : '';
    const readyVal = readyCheck && !readyRow.classList.contains('hidden') ? !!readyCheck.checked : false;
    drafts[item.id] = {
        selected: checked,
        text: textVal,
        ready: readyVal,
        visited: prev.visited !== false,
    };
}

function renderCurrentQuestion() {
    if (!items || items.length === 0) return;
    if (currentIndex >= items.length) currentIndex = items.length - 1;
    if (currentIndex < 0) currentIndex = 0;

    const item = items[currentIndex];
    const draft = ensureDraft(item, true);
    const total = items.length;
    const readyCount = items.filter((it) => isDraftReady(it)).length;

    queueTitle.textContent = 'Question ' + (currentIndex + 1) + ' of ' + total;
    queueBadge.textContent = total === 1
        ? '1 question in queue'
        : total + ' in queue · ' + readyCount + '/' + total + ' ready';

    prevBtn.disabled = currentIndex === 0;
    nextBtn.disabled = currentIndex >= total - 1;

    queuePills.innerHTML = '';
    items.forEach((it, idx) => {
        const pill = document.createElement('button');
        pill.type = 'button';
        const done = isDraftReady(it);
        pill.className = 'queue-pill' + (idx === currentIndex ? ' active' : '') + (done ? ' answered' : '');
        pill.textContent = 'Q' + (idx + 1) + (done ? ' ✓' : '');
        pill.title = it.question.slice(0, 80);
        pill.addEventListener('click', () => {
            saveCurrentDraftFromDom();
            currentIndex = idx;
            renderCurrentQuestion();
        });
        queuePills.appendChild(pill);
    });

    questionText.textContent = item.question;

    choicesContainer.innerHTML = '';
    if (item.options && item.options.length > 0) {
        choicesContainer.classList.remove('hidden');
        const inputType = item.multiSelect ? 'checkbox' : 'radio';
        item.options.forEach((opt) => {
            const label = document.createElement('label');
            label.className = 'choice' + (opt.recommended ? ' recommended' : '');
            const inp = document.createElement('input');
            inp.type = inputType;
            inp.name = 'choice';
            inp.value = opt.label;
            inp.checked = Array.isArray(draft.selected) && draft.selected.indexOf(opt.label) !== -1;
            inp.addEventListener('change', () => {
                saveCurrentDraftFromDom();
                updateHeaderBadgesOnly();
            });
            const outerSpan = document.createElement('span');
            const titleSpan = document.createElement('span');
            titleSpan.textContent = opt.label;
            outerSpan.appendChild(titleSpan);
            if (opt.description) {
                const descSpan = document.createElement('span');
                descSpan.className = 'desc';
                descSpan.textContent = opt.description;
                outerSpan.appendChild(descSpan);
            }
            label.appendChild(inp);
            label.appendChild(outerSpan);
            label.addEventListener('dblclick', () => {
                saveCurrentDraftFromDom();
                if (currentIndex < items.length - 1) {
                    currentIndex++;
                    renderCurrentQuestion();
                } else {
                    submitAll();
                }
            });
            choicesContainer.appendChild(label);
        });
    } else {
        choicesContainer.classList.add('hidden');
    }

    if (item.allowFreeform !== false) {
        answer.classList.remove('hidden');
        expand.classList.remove('hidden');
        answer.placeholder = item.placeholder || '';
        answer.value = draft.text || '';
    } else {
        answer.classList.add('hidden');
        expand.classList.add('hidden');
        answer.value = '';
    }

    if (item.readyCheckbox) {
        readyRow.classList.remove('hidden');
        readyCheck.checked = !!draft.ready;
        readyLabelText.textContent = item.readyLabel || '';
    } else {
        readyRow.classList.add('hidden');
        readyCheck.checked = false;
    }

    const onLastQuestion = currentIndex >= total - 1;
    if (total > 1) {
        bottomPrevBtn.classList.remove('hidden');
        bottomNextBtn.classList.remove('hidden');
        bottomNavDivider.classList.remove('hidden');
        bottomPrevBtn.disabled = currentIndex === 0;
        bottomNextBtn.disabled = onLastQuestion;
        bottomNextBtn.className = onLastQuestion ? 'secondary' : 'primary';
        bottomNextBtn.textContent = onLastQuestion
            ? 'Next →'
            : 'Next (' + (currentIndex + 2) + '/' + total + ') →';
        answerBtn.className = onLastQuestion ? 'primary submit-ready' : 'secondary';
        answerBtn.textContent = '✅ Submit All (' + readyCount + '/' + total + ')';
    } else {
        bottomPrevBtn.classList.add('hidden');
        bottomNextBtn.classList.add('hidden');
        bottomNavDivider.classList.add('hidden');
        answerBtn.className = 'primary';
        answerBtn.textContent = LOC.answer;
    }
}

function updateHeaderBadgesOnly() {
    const total = items.length;
    const readyCount = items.filter((it) => isDraftReady(it)).length;
    queueBadge.textContent = total === 1
        ? '1 question in queue'
        : total + ' in queue · ' + readyCount + '/' + total + ' ready';
    if (total > 1 && answerBtn) {
        answerBtn.textContent = '✅ Submit All (' + readyCount + '/' + total + ')';
    }
}

function toggleExpand() {
    if (!answer) return;
    answer.classList.toggle('expanded');
    expand.textContent = answer.classList.contains('expanded') ? LOC.collapse : LOC.expand;
    answer.focus();
}

function goPrev() {
    if (currentIndex <= 0) return;
    saveCurrentDraftFromDom();
    currentIndex--;
    renderCurrentQuestion();
}

function goNext() {
    if (currentIndex >= items.length - 1) return;
    saveCurrentDraftFromDom();
    currentIndex++;
    renderCurrentQuestion();
}

function handleCtrlEnter() {
    saveCurrentDraftFromDom();
    if (items.length > 1 && currentIndex < items.length - 1) {
        currentIndex++;
        renderCurrentQuestion();
        if (answer && !answer.classList.contains('hidden')) answer.focus();
        return;
    }
    submitAll();
}

function submitAll() {
    saveCurrentDraftFromDom();
    for (let i = 0; i < items.length; i++) {
        if (!isDraftAnswered(items[i])) {
            currentIndex = i;
            renderCurrentQuestion();
            answerBtn.textContent = '⚠️ Please answer Question ' + (i + 1) + ' of ' + items.length;
            answerBtn.style.borderColor = 'var(--vscode-inputValidation-warningBorder, #cca700)';
            setTimeout(() => {
                const readyCount = items.filter((it) => isDraftReady(it)).length;
                answerBtn.textContent = items.length > 1
                    ? ('✅ Submit All (' + readyCount + '/' + items.length + ')')
                    : LOC.answer;
                answerBtn.style.borderColor = '';
            }, 2500);
            if (answer && !answer.classList.contains('hidden')) answer.focus();
            return;
        }
    }
    const payload = {};
    items.forEach((it) => {
        const d = ensureDraft(it, false);
        payload[it.id] = {
            selected: d.selected || [],
            text: (d.text || '').trim(),
            ready: !!d.ready,
        };
    });
    vscode.postMessage({ type: 'answerAll', answers: payload });
}

window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'queueInit' && Array.isArray(msg.items)) {
        items = msg.items;
        items.forEach((it, idx) => ensureDraft(it, idx === 0));
        renderCurrentQuestion();
    } else if (msg.type === 'queueAppend' && Array.isArray(msg.items)) {
        saveCurrentDraftFromDom();
        msg.items.forEach((it) => {
            items.push(it);
            ensureDraft(it, false);
        });
        renderCurrentQuestion();
    } else if (msg.type === 'queueSync' && Array.isArray(msg.items)) {
        saveCurrentDraftFromDom();
        items = msg.items;
        if (currentIndex >= items.length) currentIndex = Math.max(0, items.length - 1);
        renderCurrentQuestion();
    }
});

// Report liveness ONLY once the host-to-panel listener above exists, so the
// queueInit reply can never be dispatched to a document with no listener.
// This is still well before the initial render, which is what the original bug
// needed: 'ready' used to be the LAST line, so a slow or throwing render meant
// the host never saw it, the startup timer fired, and a panel that was about to
// work got disposed. Ordering here is guaranteed by construction, not by an
// argument about the event loop.
vscode.postMessage({ type: 'ready' });

if (answer) {
    answer.addEventListener('input', () => {
        saveCurrentDraftFromDom();
        updateHeaderBadgesOnly();
    });
    answer.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleCtrlEnter();
        }
    });
}

window.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
    } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
    }
});

prevBtn.addEventListener('click', goPrev);
nextBtn.addEventListener('click', goNext);
bottomPrevBtn.addEventListener('click', goPrev);
bottomNextBtn.addEventListener('click', goNext);
expand.addEventListener('click', toggleExpand);
answerBtn.addEventListener('click', submitAll);
cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
readyRow.addEventListener('dblclick', submitAll);
readyCheck.addEventListener('change', () => {
    saveCurrentDraftFromDom();
    updateHeaderBadgesOnly();
});

try {
    items.forEach((it, idx) => ensureDraft(it, idx === 0));
    renderCurrentQuestion();
    if (answer && !answer.classList.contains('hidden')) answer.focus();
} catch (renderError) {
    // The panel is alive (ready already sent) but the UI failed. Say so, so the
    // failure is logged instead of looking like a hung question.
    vscode.postMessage({ type: 'renderFailed', message: String(renderError) });
}
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch] ?? ch));
}

function escapeAttr(value: string): string {
    return escapeHtml(value).replace(/`/g, '&#96;');
}

function normalizeOptions(options: HarmonyAskOptions['options']): HarmonyAskOption[] {
    return (options ?? []).map(option => {
        if (typeof option === 'string') return { label: option };
        return {
            label: String(option.label ?? '').trim(),
            description: option.description,
            recommended: !!option.recommended,
        };
    }).filter(option => option.label.length > 0);
}

function randomNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
}
