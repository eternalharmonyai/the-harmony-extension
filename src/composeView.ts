import * as vscode from 'vscode';
import { setComposePayload, ComposeImage } from './composeQueue';
import { LanguageManager } from './languageManager';

/**
 * Harmony Compose — a webview panel opened beside the chat for cases where
 * the user wants more room than the chat composer allows: long notes,
 * pasted/dropped screenshots, and quick file attachments.
 *
 * UX:
 *   - Multi-line textarea. Ctrl+Enter expands/collapses. Plain Enter inserts newline.
 *     (This mirrors the VS Code askQuestions modal workflow.)
 *   - Drag-drop or paste images (PNG/JPG/WebP) into the drop zone.
 *   - "Attach file…" button opens a workspace file picker.
 *   - "Send to Harmony" queues the payload and opens the chat with a
 *     marker prompt. The chat handler drains the queue, runs the vision
 *     pre-step on any images, and prepends everything to the user message.
 *
 * State is per-extension-host (singleton panel; reopen replaces).
 */

let currentPanel: vscode.WebviewPanel | undefined;

export function openComposeView(context: vscode.ExtensionContext): void {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.Beside);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'harmony.compose',
        'Harmony Compose',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'harmony-icon.svg');
    panel.webview.html = renderHtml();
    currentPanel = panel;

    panel.onDidDispose(() => {
        currentPanel = undefined;
    });

    panel.webview.onDidReceiveMessage(async msg => {
        switch (msg?.type) {
            case 'pickFile': {
                await handlePickFile(panel);
                return;
            }
            case 'send': {
                await handleSend(panel, msg);
                return;
            }
            case 'cancel': {
                panel.dispose();
                return;
            }
            default:
                return;
        }
    });
}

async function handlePickFile(panel: vscode.WebviewPanel): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('Harmony Compose: open a workspace folder first.');
        return;
    }
    const picks = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Attach to Harmony Compose',
        defaultUri: folders[0].uri
    });
    if (!picks || picks.length === 0) return;
    const rels: string[] = [];
    for (const uri of picks) {
        try {
            rels.push(vscode.workspace.asRelativePath(uri, false));
        } catch {
            rels.push(uri.fsPath);
        }
    }
    panel.webview.postMessage({ type: 'filesAttached', paths: rels });
}

async function handleSend(panel: vscode.WebviewPanel, msg: any): Promise<void> {
    const text: string = typeof msg.text === 'string' ? msg.text : '';
    const filePaths: string[] = Array.isArray(msg.filePaths) ? msg.filePaths.filter((s: any) => typeof s === 'string') : [];
    const rawImages: any[] = Array.isArray(msg.images) ? msg.images : [];

    const images: ComposeImage[] = [];
    for (const img of rawImages) {
        if (!img || typeof img.dataUrl !== 'string') continue;
        // dataUrl: "data:image/png;base64,XXXX"
        const match = /^data:([^;]+);base64,(.+)$/i.exec(img.dataUrl);
        if (!match) continue;
        const mimeType = match[1];
        const base64 = match[2];
        const name = typeof img.name === 'string' && img.name.length > 0
            ? img.name
            : `pasted-${Date.now()}.${guessExt(mimeType)}`;
        images.push({ mimeType, base64, name });
    }

    if (text.trim().length === 0 && filePaths.length === 0 && images.length === 0) {
        vscode.window.showInformationMessage('Harmony Compose: nothing to send.');
        return;
    }

    setComposePayload({
        text,
        filePaths,
        images,
        ts: Date.now()
    });

    panel.dispose();

    // Open the chat panel with a short marker prompt. The chat handler
    // drains the compose queue at the start of the turn, so the marker
    // prompt is replaced/augmented by the actual compose context.
    const summaryBits: string[] = [];
    if (text.trim().length > 0) summaryBits.push(`note (${text.trim().split(/\s+/).length} words)`);
    if (filePaths.length > 0) summaryBits.push(`${filePaths.length} file(s)`);
    if (images.length > 0) summaryBits.push(`${images.length} image(s)`);
    const summary = summaryBits.join(', ');

    const query = `@harmony Please consider the attached compose payload (${summary}) and respond.`;

    try {
        await vscode.commands.executeCommand('workbench.action.chat.open', { query });
    } catch {
        // Fallback: just open the chat view.
        try { await vscode.commands.executeCommand('workbench.action.chat.open'); } catch { /* ignore */ }
    }
}

function guessExt(mime: string): string {
    if (mime.includes('png')) return 'png';
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('gif')) return 'gif';
    return 'bin';
}

function renderHtml(): string {
    const lm = LanguageManager.getInstance();
    const nonce = randomNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<title>Harmony Compose</title>
<style>
    :root { color-scheme: light dark; }
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        margin: 0;
        padding: 16px;
        display: flex;
        flex-direction: column;
        height: 100vh;
        box-sizing: border-box;
    }
    h2 {
        margin: 0 0 8px 0;
        font-size: 1.1em;
        font-weight: 600;
    }
    .hint {
        opacity: 0.7;
        font-size: 0.85em;
        margin-bottom: 12px;
    }
    textarea#composeText {
        flex: 1;
        min-height: 120px;
        resize: vertical;
        padding: 10px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, 13px);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 4px;
        box-sizing: border-box;
    }
    textarea#composeText:focus {
        outline: 1px solid var(--vscode-focusBorder);
        border-color: var(--vscode-focusBorder);
    }
    .dropzone {
        margin-top: 12px;
        padding: 14px;
        border: 2px dashed var(--vscode-input-border, var(--vscode-foreground));
        border-radius: 6px;
        text-align: center;
        opacity: 0.85;
        transition: background 0.15s;
    }
    .dropzone.over {
        background: var(--vscode-list-hoverBackground);
        opacity: 1;
    }
    .attachments {
        margin-top: 10px;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }
    .chip {
        padding: 3px 8px;
        border-radius: 12px;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        font-size: 0.85em;
        display: inline-flex;
        align-items: center;
        gap: 4px;
    }
    .chip button {
        background: transparent;
        border: none;
        color: inherit;
        cursor: pointer;
        font-size: 1em;
        padding: 0 0 0 4px;
    }
    .imageGrid {
        margin-top: 10px;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
        gap: 6px;
    }
    .imageGrid figure {
        margin: 0;
        position: relative;
    }
    .imageGrid img {
        width: 100%;
        height: 80px;
        object-fit: cover;
        border-radius: 4px;
        border: 1px solid var(--vscode-input-border, transparent);
    }
    .imageGrid button.remove {
        position: absolute;
        top: 2px;
        right: 2px;
        background: rgba(0,0,0,0.55);
        color: white;
        border: none;
        border-radius: 50%;
        width: 18px;
        height: 18px;
        font-size: 11px;
        cursor: pointer;
        line-height: 1;
    }
    .actions {
        margin-top: 12px;
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        align-items: center;
    }
    button.btn {
        padding: 6px 14px;
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.9em;
    }
    button.btn.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    button.btn.primary:hover {
        background: var(--vscode-button-hoverBackground);
    }
    button.btn.secondary {
        background: var(--vscode-button-secondaryBackground, transparent);
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    }
    button.btn.secondary:hover {
        background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
    }
    button.btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
    }
    .payloadStatus {
        margin-top: 8px;
        opacity: 0.75;
        font-size: 0.85em;
    }
    .kbd {
        font-family: var(--vscode-editor-font-family, monospace);
        background: var(--vscode-keybindingLabel-background, rgba(128,128,128,0.2));
        padding: 1px 5px;
        border-radius: 3px;
        font-size: 0.85em;
    }
    textarea#composeText.expanded {
        min-height: 55vh;
    }
</style>
</head>
<body>
    <h2>${lm.getString('compose.title')}</h2>
    <div class="hint">
        ${lm.getString('compose.hint')}
        <span class="kbd">Ctrl</span>+<span class="kbd">Enter</span> ${lm.getString('compose.ctrlEnter')}.
        <span class="kbd">Enter</span> = ${lm.getString('compose.enterNewline')}.
    </div>
    <textarea id="composeText" placeholder="${lm.getString('compose.placeholder')}"></textarea>

    <div class="dropzone" id="dropzone">
        ${lm.getString('compose.dropzone')}
    </div>

    <div class="imageGrid" id="imageGrid"></div>
    <div class="attachments" id="fileChips"></div>
    <div class="payloadStatus" id="payloadStatus">${lm.getString('compose.emptyDraft')}</div>

    <div class="actions">
        <button class="btn secondary" id="expandBtn">${lm.getString('compose.expand')}</button>
        <button class="btn secondary" id="attachFileBtn">${lm.getString('compose.attachFile')}</button>
        <span style="flex:1"></span>
        <button class="btn secondary" id="cancelBtn">${lm.getString('compose.cancel')}</button>
        <button class="btn primary" id="sendBtn">${lm.getString('compose.send')}</button>
    </div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const LOC = ${JSON.stringify({
    empty_draft: lm.getString('compose.emptyDraft'),
    chars: lm.getString('compose.chars'),
    images: lm.getString('compose.images'),
    files: lm.getString('compose.files'),
    remove: lm.getString('compose.remove'),
})};
const textarea = document.getElementById('composeText');
const dropzone = document.getElementById('dropzone');
const imageGrid = document.getElementById('imageGrid');
const fileChips = document.getElementById('fileChips');
const sendBtn = document.getElementById('sendBtn');
const cancelBtn = document.getElementById('cancelBtn');
const attachFileBtn = document.getElementById('attachFileBtn');
const expandBtn = document.getElementById('expandBtn');
const payloadStatus = document.getElementById('payloadStatus');

let images = []; // { dataUrl, name }
let filePaths = [];

function updatePayloadStatus() {
    const chars = textarea.value.length;
    const parts = [];
    if (chars > 0) parts.push(chars + ' ' + LOC.chars);
    if (images.length > 0) parts.push(images.length + ' ' + LOC.images);
    if (filePaths.length > 0) parts.push(filePaths.length + ' ' + LOC.files);
    payloadStatus.textContent = parts.length ? parts.join(' • ') : LOC.empty_draft;
    sendBtn.disabled = parts.length === 0;
}

function renderImages() {
    imageGrid.innerHTML = '';
    images.forEach((img, idx) => {
        const fig = document.createElement('figure');
        const el = document.createElement('img');
        el.src = img.dataUrl;
        el.alt = img.name;
        el.title = img.name;
        const rm = document.createElement('button');
        rm.className = 'remove';
        rm.textContent = '×';
        rm.title = LOC.remove;
        rm.onclick = () => { images.splice(idx, 1); renderImages(); };
        fig.appendChild(el);
        fig.appendChild(rm);
        imageGrid.appendChild(fig);
    });
    updatePayloadStatus();
}

function renderFiles() {
    fileChips.innerHTML = '';
    filePaths.forEach((p, idx) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = p;
        const rm = document.createElement('button');
        rm.textContent = '×';
        rm.title = LOC.remove;
        rm.onclick = () => { filePaths.splice(idx, 1); renderFiles(); };
        chip.appendChild(rm);
        fileChips.appendChild(chip);
    });
    updatePayloadStatus();
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function addFiles(fileList) {
    for (const file of fileList) {
        if (!file.type || !file.type.startsWith('image/')) continue;
        try {
            const dataUrl = await readFileAsDataUrl(file);
            images.push({ dataUrl, name: file.name || 'pasted-image' });
        } catch (e) { /* ignore */ }
    }
    renderImages();
}

dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('over');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', async e => {
    e.preventDefault();
    dropzone.classList.remove('over');
    if (e.dataTransfer && e.dataTransfer.files) {
        await addFiles(e.dataTransfer.files);
    }
});

// Paste support anywhere in the document.
document.addEventListener('paste', async e => {
    if (!e.clipboardData) return;
    const items = e.clipboardData.items;
    const files = [];
    for (const item of items) {
        if (item.kind === 'file') {
            const f = item.getAsFile();
            if (f) files.push(f);
        }
    }
    if (files.length > 0) {
        e.preventDefault();
        await addFiles(files);
    }
});

function toggleExpand() {
    textarea.classList.toggle('expanded');
    expandBtn.textContent = textarea.classList.contains('expanded') ? 'Collapse' : 'Expand';
    textarea.focus();
}

textarea.addEventListener('keydown', e => {
    // Ctrl+Enter (or Cmd+Enter on Mac) expands/collapses.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        toggleExpand();
    }
});
textarea.addEventListener('input', updatePayloadStatus);

expandBtn.addEventListener('click', toggleExpand);

attachFileBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'pickFile' });
});

cancelBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
});

sendBtn.addEventListener('click', () => doSend());

function doSend() {
    vscode.postMessage({
        type: 'send',
        text: textarea.value,
        filePaths,
        images
    });
}

window.addEventListener('message', evt => {
    const msg = evt.data;
    if (!msg) return;
    if (msg.type === 'filesAttached' && Array.isArray(msg.paths)) {
        for (const p of msg.paths) {
            if (!filePaths.includes(p)) filePaths.push(p);
        }
        renderFiles();
    }
});

textarea.focus();
updatePayloadStatus();
</script>
</body>
</html>`;
}

function randomNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
}
