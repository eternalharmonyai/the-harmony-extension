import * as vscode from 'vscode';
import { LanguageManager } from './languageManager';

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
 * Ask the user with VS Code-native prompts first. The webview is kept only as
 * a fallback surface because QuickInput is tied to VS Code's own focus and
 * lifecycle handling, which is much more reliable inside chat turns.
 */
export async function showHarmonyAsk(input: HarmonyAskOptions, token?: vscode.CancellationToken): Promise<string | undefined> {
    return showHarmonyAskWebview(input, token);
}

function showHarmonyAskWebview(input: HarmonyAskOptions, token?: vscode.CancellationToken): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
        const panel = vscode.window.createWebviewPanel(
            ASK_VIEW_TYPE,
            'Harmony Ask',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true }
        );

        let settled = false;
        let ready = false;
        let readyTimer: NodeJS.Timeout | undefined;
        let cancelSub: vscode.Disposable | undefined;

        const cleanup = () => {
            if (readyTimer) clearTimeout(readyTimer);
            cancelSub?.dispose();
        };

        const finish = (value: string | undefined) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
            panel.dispose();
        };

        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            panel.dispose();
            reject(error);
        };

        panel.onDidDispose(() => finish(undefined));
        panel.webview.onDidReceiveMessage((msg) => {
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'ready') {
                ready = true;
                if (readyTimer) clearTimeout(readyTimer);
                return;
            }
            if (msg.type === 'cancel') {
                finish(undefined);
                return;
            }
            if (msg.type === 'answer') {
                const selected = Array.isArray(msg.selected)
                    ? msg.selected.map((value: unknown) => String(value).trim()).filter(Boolean).join('\n')
                    : typeof msg.selected === 'string' ? msg.selected.trim() : '';
                const text = typeof msg.text === 'string' ? msg.text.trim() : '';
                const ready = msg.ready === true ? '\n\n✅ Ready' : '';
                if (selected && text) finish(`${selected}\n\n${text}${ready}`);
                else if (selected) finish(`${selected}${ready}`);
                else finish(text || ready || undefined);
            }
        });

        cancelSub = token?.onCancellationRequested(() => finish(undefined));
        readyTimer = setTimeout(() => {
            if (!ready) fail(new Error('Harmony Ask webview did not report ready.'));
        }, ASK_READY_TIMEOUT_MS);

        const nonce = randomNonce();
        panel.webview.html = renderAskHtml(input, nonce);
    });
}



function renderAskHtml(input: HarmonyAskOptions, nonce: string): string {
    const lm = LanguageManager.getInstance();
    const question = escapeHtml(input.question);
    const options = normalizeOptions(input.options);
    const allowFreeform = input.allowFreeformInput !== false;
    const inputType = input.multiSelect ? 'checkbox' : 'radio';
    const optionHtml = options.map((o, i) => `
        <label class="choice ${o.recommended ? 'recommended' : ''}">
            <input type="${inputType}" name="choice" value="${escapeAttr(o.label)}" ${i === 0 && !input.multiSelect ? 'checked' : ''}>
            <span><span>${escapeHtml(o.label)}</span>${o.description ? `<span class="desc">${escapeHtml(o.description)}</span>` : ''}</span>
        </label>`).join('');

    const textareaPlaceholder = input.multiline || options.length > 0
        ? lm.getString('ask.placeholderWithOptions')
        : lm.getString('ask.placeholder');

    const localized = {
        expand: lm.getString('ask.expand'),
        collapse: lm.getString('ask.collapse'),
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
    }
    button {
        padding: 6px 14px;
        border-radius: 4px;
        border: 1px solid var(--vscode-button-border, transparent);
        cursor: pointer;
        font-size: 0.9em;
    }
    button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
        background: var(--vscode-button-secondaryBackground, transparent);
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
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
</style>
</head>
<body>
    <div class="question">${question}</div>
    ${options.length > 0 ? `<div class="choices">${optionHtml}</div>` : ''}
    ${allowFreeform ? `<textarea id="answer" placeholder="${escapeAttr(textareaPlaceholder)}"></textarea>` : ''}
    <div class="hint">${escapeHtml(lm.getString('ask.hint'))}</div>
    ${input.readyCheckbox ? `
    <label class="ready-row">
        <input type="checkbox" id="readyCheck">
        <span>${escapeHtml(input.readyLabel || lm.getString('ask.readyLabel'))}</span>
    </label>` : ''}
    <div class="actions">
        <button class="secondary" id="expand">${escapeHtml(lm.getString('ask.expand'))}</button>
        <span class="spacer"></span>
        <button class="secondary" id="cancel">${escapeHtml(lm.getString('ask.cancel'))}</button>
        <button class="primary" id="answerBtn">${escapeHtml(lm.getString('ask.answer'))}</button>
    </div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const answer = document.getElementById('answer');
const expand = document.getElementById('expand');
const answerBtn = document.getElementById('answerBtn');
const cancel = document.getElementById('cancel');
const LOC = ${JSON.stringify(localized)};

function selectedChoice() {
    return Array.from(document.querySelectorAll('input[name="choice"]:checked')).map((input) => input.value);
}
function toggleExpand() {
    if (!answer) return;
    answer.classList.toggle('expanded');
    expand.textContent = answer.classList.contains('expanded') ? LOC.collapse : LOC.expand;
    answer.focus();
}
function submit() {
    const ready = document.getElementById('readyCheck');
    vscode.postMessage({ type: 'answer', selected: selectedChoice(), text: answer ? answer.value : '', ready: ready ? ready.checked : false });
}

if (answer) answer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit();
    }
});
expand.addEventListener('click', toggleExpand);
answerBtn.addEventListener('click', submit);
cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

document.querySelectorAll('.choice').forEach((label) => {
    label.addEventListener('dblclick', submit);
});
// Double-click ready-row for quick flow-state signal
const readyRow = document.querySelector('.ready-row');
if (readyRow) readyRow.addEventListener('dblclick', submit);
if (answer) answer.focus();
vscode.postMessage({ type: 'ready' });
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
