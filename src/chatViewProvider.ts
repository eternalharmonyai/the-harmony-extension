import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { ToolCall, ToolResult, executeTool, isInteractiveTool } from './toolExecutor';
import {
    AgentHistoryEntry,
    buildTurnPrompt,
    formatWorkspaceContext,
    parseAgentOutput,
    requestVsCodeLanguageModel
} from './localAgent';

const DEFAULT_AGENT_MAX_STEPS = 1111;
const MAX_AGENT_STEPS_SETTING = 5000;

interface AgentStepLimit {
    maxSteps: number;
    label: string;
}

/**
 * Webview chat panel. Default mode is VS Code-standalone:
 * the extension uses VS Code's Language Model API and executes tools locally.
 * The HTTP backend remains available as an optional fallback/compatibility mode.
 */
export class HarmonyChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'harmony.chatView';

    private view?: vscode.WebviewView;
    private currentProfile: string;
    private currentThreadId: string | null = null;
    private agentRunning = false;
    private localHistory: AgentHistoryEntry[] = [];

    // Map from question card ID -> resolver waiting for the user's choice.
    private pendingQuestions = new Map<string, (answer: string) => void>();
    private pendingWebviewMessages: Record<string, unknown>[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly workspaceState: vscode.Memento
    ) {
        this.currentProfile = vscode.workspace.getConfiguration('harmony').get<string>('defaultProfile') ?? 'default';
        this.localHistory = this.workspaceState.get<AgentHistoryEntry[]>(this.historyKey(), []);
    }

    public setProfile(profile: string) {
        this.resolvePendingQuestions('user cancelled');
        this.currentProfile = profile;
        this.currentThreadId = null;
        this.localHistory = this.workspaceState.get<AgentHistoryEntry[]>(this.historyKey(), []);
        this.view?.webview.postMessage({ type: 'profileChanged', profile });
    }

    public refreshBackend() {
        this.handleBackendPing();
    }

    private configuredProvider(): string {
        const cfg = vscode.workspace.getConfiguration('harmony');
        const legacyProvider = cfg.get<string>('provider');
        if (legacyProvider === 'harmony-backend' || legacyProvider === 'auto') return legacyProvider;
        return cfg.get<string>('modelProvider') ?? legacyProvider ?? 'vscode-lm';
    }

    private agentStepLimit(): AgentStepLimit {
        const raw = vscode.workspace.getConfiguration('harmony').get<number>('agentMaxSteps') ?? DEFAULT_AGENT_MAX_STEPS;
        if (raw === -1) return { maxSteps: Number.MAX_SAFE_INTEGER, label: 'unlimited' };
        const bounded = Math.max(1, Math.min(MAX_AGENT_STEPS_SETTING, Math.floor(Number(raw) || DEFAULT_AGENT_MAX_STEPS)));
        return { maxSteps: bounded, label: String(bounded) };
    }

    private historyKey(profile = this.currentProfile): string {
        return `harmony.localHistory.${profile}`;
    }

    private async persistLocalHistory() {
        await this.workspaceState.update(this.historyKey(), this.localHistory.slice(-40));
    }

    private resolvePendingQuestions(answer: string): void {
        for (const resolver of this.pendingQuestions.values()) {
            try { resolver(answer); } catch { /* ignore */ }
        }
        this.pendingQuestions.clear();
    }

    private queueWebviewMessage(message: Record<string, unknown>): void {
        this.pendingWebviewMessages.push(message);
        if (this.pendingWebviewMessages.length > 100) {
            this.pendingWebviewMessages.splice(0, this.pendingWebviewMessages.length - 100);
        }
    }

    private flushWebviewMessages(): void {
        if (!this.view || this.pendingWebviewMessages.length === 0) return;
        const queued = this.pendingWebviewMessages.splice(0);
        for (const message of queued) {
            this.view.webview.postMessage(message).then(undefined, (error) => {
                console.warn('[Harmony] failed to flush webview message', message.type, error);
                this.queueWebviewMessage(message);
            });
        }
    }

    private postToWebview(message: Record<string, unknown>): boolean {
        if (!this.view) {
            this.queueWebviewMessage(message);
            return false;
        }
        this.view.webview.postMessage(message).then((ok) => {
            if (!ok) {
                console.warn('[Harmony] webview rejected message', message.type);
                this.queueWebviewMessage(message);
            }
        }, (error) => {
            console.warn('[Harmony] failed to post webview message', message.type, error);
            this.queueWebviewMessage(message);
        });
        return true;
    }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };
        webviewView.webview.html = this.getHtml();

        webviewView.onDidDispose(() => {
            if (this.view === webviewView) this.view = undefined;
            this.resolvePendingQuestions('user cancelled');
        });

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'ready':
                    this.flushWebviewMessages();
                    break;
                case 'send':
                    if (this.agentRunning) {
                        this.view?.webview.postMessage({ type: 'info', text: 'Agent is busy — wait for current turn.' });
                        return;
                    }
                    await this.runAgentLoop(message.text, !!message.includeContext);
                    break;
                case 'ping':
                    await this.handleBackendPing();
                    break;
                case 'newThread':
                    await this.resetThread();
                    break;
                case 'questionAnswer':
                    {
                        const resolver = this.pendingQuestions.get(message.cardId);
                        if (resolver) {
                            this.pendingQuestions.delete(message.cardId);
                            resolver(message.answer);
                        }
                    }
                    break;
            }
        });

        this.view?.webview.postMessage({ type: 'profileChanged', profile: this.currentProfile });
    }

    private async resetThread() {
        this.resolvePendingQuestions('user cancelled');
        const cfg = vscode.workspace.getConfiguration('harmony');
        const backendUrl = cfg.get<string>('backendUrl') ?? 'http://127.0.0.1:8889';
        const previousThreadId = this.currentThreadId;
        this.currentThreadId = null;
        this.localHistory = [];
        await this.workspaceState.update(this.historyKey(), undefined);

        try {
            await this.postJson(`${backendUrl}/ext/v1/agent/reset`, {
                thread_id: previousThreadId,
                profile: this.currentProfile,
            });
        } catch {
            // best-effort; UI continues regardless
        }
        this.view?.webview.postMessage({ type: 'info', text: 'Started a new thread.' });
    }

    private collectWorkspaceContext(): Record<string, unknown> | undefined {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return undefined;
        const doc = editor.document;
        const sel = editor.selection;
        const selectionText = !sel.isEmpty ? doc.getText(sel) : '';
        const selectionRange = !sel.isEmpty ? [sel.start.line + 1, sel.end.line + 1] : undefined;

        const diags = vscode.languages.getDiagnostics();
        let errors = 0;
        let warnings = 0;
        for (const [, list] of diags) {
            for (const d of list) {
                if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
                else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
            }
        }
        const diagnosticsSummary = `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`;

        const openFiles: string[] = [];
        try {
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    const input: any = tab.input;
                    if (input && input.uri && typeof input.uri.fsPath === 'string') {
                        openFiles.push(this.relativePath(input.uri));
                    }
                }
            }
        } catch { /* older VS Code */ }

        return {
            active_file: this.relativePath(doc.uri),
            language: doc.languageId,
            selection: selectionText,
            selection_range: selectionRange,
            diagnostics_summary: diagnosticsSummary,
            open_files: openFiles
        };
    }

    private relativePath(uri: vscode.Uri): string {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        return folder ? vscode.workspace.asRelativePath(uri, false) : uri.fsPath;
    }

    /**
     * Drive the agent loop until a final answer is reached or an error/abort.
     * Default mode is VS Code standalone. Backend mode remains explicit/optional.
     */
    private async runAgentLoop(userMessage: string, includeContext: boolean) {
        this.agentRunning = true;
        const provider = this.configuredProvider();

        try {
            if (provider === 'harmony-backend') {
                await this.runBackendAgentLoop(userMessage, includeContext);
                return;
            }

            try {
                await this.runLocalAgentLoop(userMessage, includeContext);
                return;
            } catch (err: any) {
                if (provider === 'auto') {
                    this.view?.webview.postMessage({ type: 'info', text: 'VS Code model unavailable; trying optional backend fallback.' });
                    await this.runBackendAgentLoop(userMessage, includeContext);
                    return;
                }
                throw err;
            }
        } catch (err: any) {
            this.view?.webview.postMessage({
                type: 'error',
                text: `Agent error: ${err?.message ?? err}`
            });
        } finally {
            this.agentRunning = false;
            this.view?.webview.postMessage({ type: 'thinkingDone' });
        }
    }

    private async runLocalAgentLoop(userMessage: string, includeContext: boolean) {
        const cfg = vscode.workspace.getConfiguration('harmony');
        const stepLimit = this.agentStepLimit();
        const workspaceContextBlock = includeContext ? formatWorkspaceContext(this.collectWorkspaceContext()) : '';

        let pendingUserMessage: string | null = userMessage;
        let pendingToolResult: ToolResult | null = null;

        for (let step = 0; step < stepLimit.maxSteps; step++) {
            this.view?.webview.postMessage({ type: 'thinking', step: step + 1 });
            const prompt = buildTurnPrompt({
                userMessage: pendingUserMessage,
                workspaceContextBlock,
                history: this.localHistory,
                toolResult: pendingToolResult
            });
            const response = await requestVsCodeLanguageModel(prompt);
            this.view?.webview.postMessage({ type: 'thinkingDone' });

            if (pendingUserMessage) {
                this.localHistory.push({ role: 'user', content: pendingUserMessage });
                pendingUserMessage = null;
            }
            if (pendingToolResult) {
                this.localHistory.push({
                    role: 'tool',
                    tag: pendingToolResult.tool_call_id,
                    content: JSON.stringify({ ok: pendingToolResult.ok, result: pendingToolResult.result })
                });
                pendingToolResult = null;
            }

            const stepData = parseAgentOutput(response.text);
            if (stepData.kind === 'final') {
                this.localHistory.push({ role: 'assistant', content: stepData.text || '' });
                await this.persistLocalHistory();
                this.view?.webview.postMessage({ type: 'reply', text: stepData.text || '(no reply)' });
                return;
            }

            const call: ToolCall = {
                id: stepData.id,
                name: stepData.name,
                arguments: stepData.arguments || {}
            };
            this.localHistory.push({
                role: 'assistant',
                tag: 'tool_call',
                content: JSON.stringify({ id: call.id, name: call.name, arguments: call.arguments })
            });

            this.postToWebview({
                type: 'toolCall',
                id: call.id,
                name: call.name,
                argsJson: JSON.stringify(call.arguments, null, 2)
            });

            pendingToolResult = await this.executeAgentTool(call);
            this.postToWebview({
                type: 'toolResult',
                id: call.id,
                ok: pendingToolResult.ok,
                text: pendingToolResult.result
            });
            await this.persistLocalHistory();
        }

        this.view?.webview.postMessage({
            type: 'error',
            text: `Agent stopped - exceeded ${stepLimit.label} steps. Configure 'harmony.agentMaxSteps' to change this.`
        });
    }

    private async runBackendAgentLoop(userMessage: string, includeContext: boolean) {
        const cfg = vscode.workspace.getConfiguration('harmony');
        const backendUrl = cfg.get<string>('backendUrl') ?? 'http://127.0.0.1:8889';
        const stepLimit = this.agentStepLimit();

        const baseBody = (): Record<string, unknown> => ({
            profile: this.currentProfile,
            ...(this.currentThreadId ? { thread_id: this.currentThreadId } : {}),
        });

        let nextBody: Record<string, unknown> = {
            ...baseBody(),
            message: userMessage,
        };
        if (includeContext) {
            const ctx = this.collectWorkspaceContext();
            if (ctx) nextBody.context = ctx;
        }

        for (let step = 0; step < stepLimit.maxSteps; step++) {
            this.view?.webview.postMessage({ type: 'thinking', step: step + 1 });
            const resp = await this.postJson(`${backendUrl}/ext/v1/agent/turn`, nextBody);
            this.view?.webview.postMessage({ type: 'thinkingDone' });

            if (!resp || !resp.ok) {
                this.view?.webview.postMessage({ type: 'error', text: `Backend error: ${resp?.error ?? 'unknown'}` });
                return;
            }

            if (resp.thread_id) this.currentThreadId = resp.thread_id;
            const stepData = resp.step;

            if (stepData.kind === 'final') {
                this.view?.webview.postMessage({ type: 'reply', text: stepData.text || '(no reply)' });
                return;
            }

            if (stepData.kind === 'tool_call') {
                const call: ToolCall = {
                    id: stepData.id,
                    name: stepData.name,
                    arguments: stepData.arguments || {},
                };

                this.postToWebview({
                    type: 'toolCall',
                    id: call.id,
                    name: call.name,
                    argsJson: JSON.stringify(call.arguments, null, 2),
                });

                const toolResult = await this.executeAgentTool(call);
                this.postToWebview({
                    type: 'toolResult',
                    id: call.id,
                    ok: toolResult.ok,
                    text: toolResult.result,
                });

                nextBody = {
                    ...baseBody(),
                    tool_result: toolResult,
                };
                continue;
            }

            this.view?.webview.postMessage({ type: 'error', text: `Unknown step kind: ${stepData.kind}` });
            return;
        }

        this.view?.webview.postMessage({
            type: 'error',
            text: `Agent stopped - exceeded ${stepLimit.label} steps. Configure 'harmony.agentMaxSteps' to change this.`
        });
    }

    private async executeAgentTool(call: ToolCall): Promise<ToolResult> {
        if (call.name === 'final_answer') {
            return { tool_call_id: call.id, ok: true, result: String(call.arguments?.text ?? '') };
        }

        if (call.name === 'ask_question') {
            const answer = await this.askQuestionInUI(call);
            return { tool_call_id: call.id, ok: true, result: answer };
        }

        if (isInteractiveTool(call.name)) {
            return { tool_call_id: call.id, ok: false, result: `interactive tool not implemented: ${call.name}` };
        }

        const result = await executeTool(call);
        return result ?? { tool_call_id: call.id, ok: false, result: `unknown tool: ${call.name}` };
    }

    /**
     * Render an ask_question tool call as an interactive card in the webview
     * and await the user's selection.
     */
    private async askQuestionInUI(call: ToolCall): Promise<string> {
        const args = call.arguments || {};
        const questions = Array.isArray(args.questions) && args.questions.length > 0 ? args.questions : [args];
        const answers: Array<{ question: string; answer: string }> = [];
        for (let i = 0; i < questions.length; i++) {
            const answer = await this.askSingleQuestionInUI(call.id, questions[i] || {}, i);
            const question = String((questions[i] || {}).question ?? '(no question)');
            answers.push({ question, answer });
            if (answer === 'user cancelled') return answer;
        }
        return questions.length === 1 ? answers[0].answer : JSON.stringify({ answers });
    }

    private askSingleQuestionInUI(callId: string, args: Record<string, any>, index: number): Promise<string> {
        const cardId = `q_${callId}_${index}`;
        const rawOptions = Array.isArray(args.options) ? args.options : [];
        const options = rawOptions.map((opt: any) => {
            if (typeof opt === 'string') return { label: opt };
            return {
                label: String(opt?.label ?? opt?.value ?? '').trim(),
                description: typeof opt?.description === 'string' ? opt.description : undefined,
                recommended: !!opt?.recommended,
            };
        }).filter((opt: { label: string }) => opt.label.length > 0);
        return new Promise<string>((resolve) => {
            if (!this.view) {
                resolve('user cancelled');
                return;
            }
            this.pendingQuestions.set(cardId, resolve);
            this.view.webview.postMessage({
                type: 'askQuestion',
                cardId,
                question: args.question || '(no question)',
                options,
                allowFreeform: (args.allowFreeformInput ?? args.allow_freeform) !== false,
                multiSelect: !!(args.multiSelect ?? args.multi_select),
            }).then((ok) => {
                if (!ok && this.pendingQuestions.get(cardId) === resolve) {
                    this.pendingQuestions.delete(cardId);
                    resolve('user cancelled');
                }
            }, () => {
                if (this.pendingQuestions.get(cardId) === resolve) {
                    this.pendingQuestions.delete(cardId);
                    resolve('user cancelled');
                }
            });
        });
    }

    private async handleBackendPing() {
        const cfg = vscode.workspace.getConfiguration('harmony');
        const provider = this.configuredProvider();
        if (provider === 'vscode-lm') {
            this.view?.webview.postMessage({ type: 'backendStatus', ok: true, detail: 'standalone: VS Code model' });
            return;
        }
        if (provider === 'auto') {
            this.view?.webview.postMessage({ type: 'backendStatus', ok: true, detail: 'standalone first; backend optional' });
            return;
        }

        const backendUrl = cfg.get<string>('backendUrl') ?? 'http://127.0.0.1:8889';
        try {
            const data = await this.getJson(`${backendUrl}/ext/v1/health`);
            const ok = !!(data && data.ok);
            this.view?.webview.postMessage({
                type: 'backendStatus',
                ok,
                detail: ok ? `v${data.version ?? '?'} • profiles: ${(data.profiles || []).join(', ')}` : 'not ready'
            });
        } catch {
            this.view?.webview.postMessage({ type: 'backendStatus', ok: false, detail: 'offline' });
        }
    }

    private postJson(url: string, body: object): Promise<any> {
        return new Promise((resolve, reject) => {
            const u = new URL(url);
            const lib = u.protocol === 'https:' ? https : http;
            const data = JSON.stringify(body);
            const req = lib.request(
                {
                    hostname: u.hostname,
                    port: u.port,
                    path: u.pathname + u.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data),
                    },
                    timeout: 120_000,
                },
                (res) => {
                    let chunks = '';
                    res.on('data', (c) => (chunks += c));
                    res.on('end', () => {
                        try { resolve(JSON.parse(chunks)); }
                        catch { reject(new Error(`Bad JSON from ${url}: ${chunks.slice(0, 200)}`)); }
                    });
                }
            );
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(new Error('request timeout')); });
            req.write(data);
            req.end();
        });
    }

    private getJson(url: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const u = new URL(url);
            const lib = u.protocol === 'https:' ? https : http;
            const req = lib.get(url, (res) => {
                let chunks = '';
                res.on('data', (c) => (chunks += c));
                res.on('end', () => {
                    try { resolve(JSON.parse(chunks)); }
                    catch { reject(new Error(`Bad JSON from ${url}: ${chunks.slice(0, 200)}`)); }
                });
            });
            req.setTimeout(5000, () => { req.destroy(new Error('request timeout')); });
            req.on('error', reject);
        });
    }

    private getHtml(): string {
        return /* html */ `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin:0; padding:8px; display:flex; flex-direction:column; height:100vh; }
  #header { display:flex; justify-content:space-between; align-items:center; padding-bottom:6px; border-bottom:1px solid var(--vscode-panel-border); gap:8px; }
  #profile { font-weight:bold; color:#c084fc; }
  #status { font-size:11px; opacity:0.8; }
  #status.ok { color:#22c55e; } #status.bad { color:#ef4444; }
  #toolbar { display:flex; gap:4px; }
  .tbtn { font-size:11px; padding:2px 6px; background:transparent; color:var(--vscode-foreground); border:1px solid var(--vscode-panel-border); border-radius:3px; cursor:pointer; }
  .tbtn:hover { background:var(--vscode-list-hoverBackground); }
  #messages { flex:1; overflow-y:auto; padding:8px 0; display:flex; flex-direction:column; gap:8px; }
  .msg { padding:6px 10px; border-radius:6px; max-width:90%; word-wrap:break-word; white-space:pre-wrap; }
  .msg.user { align-self:flex-end; background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
  .msg.assistant { align-self:flex-start; background:var(--vscode-input-background); border:1px solid var(--vscode-panel-border); }
  .msg.error { align-self:stretch; background:var(--vscode-inputValidation-errorBackground); color:var(--vscode-inputValidation-errorForeground); border:1px solid var(--vscode-inputValidation-errorBorder); font-size:12px; }
  .msg.info { align-self:center; opacity:0.7; font-size:11px; font-style:italic; background:transparent; }
  .tool { align-self:stretch; font-size:11px; border-left:2px solid #c084fc; padding:4px 8px; background:var(--vscode-textBlockQuote-background); border-radius:3px; }
  .tool .head { font-weight:bold; color:#c084fc; cursor:pointer; }
  .tool pre { margin:4px 0 0 0; max-height:200px; overflow:auto; font-family:var(--vscode-editor-font-family); font-size:11px; white-space:pre-wrap; }
  .tool.collapsed pre { display:none; }
  .tool .res { border-top:1px dashed var(--vscode-panel-border); margin-top:4px; padding-top:4px; }
  .tool .res.error { color:#ef4444; }
  .question-card { align-self:stretch; padding:8px 10px; border:1px solid #c084fc; border-radius:6px; background:var(--vscode-input-background); }
  .question-card .q { font-weight:bold; margin-bottom:6px; }
  .question-card .opt { display:block; padding:4px 6px; margin:2px 0; border:1px solid var(--vscode-panel-border); border-radius:3px; cursor:pointer; }
  .question-card .opt:hover { background:var(--vscode-list-hoverBackground); }
  .question-card .opt.recommended { border-color:#c084fc; }
  .question-card .opt .desc { font-size:11px; opacity:0.7; }
  .question-card textarea { width:100%; box-sizing:border-box; margin-top:6px; min-height:48px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); padding:4px; }
  .question-card .nuance-label { font-size:11px; opacity:0.7; margin-top:8px; margin-bottom:2px; }
  .question-card .submit { margin-top:6px; padding:4px 10px; background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; border-radius:3px; cursor:pointer; }
  .thinking { align-self:flex-start; opacity:0.6; font-size:11px; font-style:italic; }
  #composer { display:flex; flex-direction:column; gap:4px; padding-top:6px; border-top:1px solid var(--vscode-panel-border); }
  #composer-row { display:flex; gap:6px; }
  #input { flex:1; padding:6px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); border-radius:4px; }
  #send { padding:6px 12px; background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; border-radius:4px; cursor:pointer; }
  #send:hover { background:var(--vscode-button-hoverBackground); }
  #context-toggle { font-size:11px; opacity:0.85; display:flex; align-items:center; gap:4px; }
</style>
</head>
<body>
  <div id="header">
    <div>Profile: <span id="profile">default</span></div>
    <div id="toolbar">
      <button class="tbtn" id="newThreadBtn" title="Reset agent state for this profile">+ New</button>
      <button class="tbtn" id="pingBtn" title="Re-check backend">↻</button>
    </div>
    <div id="status">checking backend…</div>
  </div>
  <div id="messages"></div>
  <div id="composer">
    <div id="composer-row">
      <input id="input" type="text" placeholder="Type a message…" />
      <button id="send">Send</button>
    </div>
    <label id="context-toggle">
      <input type="checkbox" id="ctxBox" checked />
      Include workspace context (active file, selection, diagnostics)
    </label>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendEl = document.getElementById('send');
  const profileEl = document.getElementById('profile');
  const statusEl = document.getElementById('status');
  const ctxBox = document.getElementById('ctxBox');
  const newThreadBtn = document.getElementById('newThreadBtn');
  const pingBtn = document.getElementById('pingBtn');

  let thinkingEl = null;
  const toolEls = new Map();

  function add(el) {
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMessage(text, role) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = text;
    add(div);
    return div;
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    addMessage(text, 'user');
    vscode.postMessage({ type: 'send', text, includeContext: ctxBox.checked });
    inputEl.value = '';
  }

  sendEl.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  newThreadBtn.addEventListener('click', () => vscode.postMessage({ type: 'newThread' }));
  pingBtn.addEventListener('click', () => vscode.postMessage({ type: 'ping' }));

  function showThinking(step) {
    if (!thinkingEl) {
      thinkingEl = document.createElement('div');
      thinkingEl.className = 'thinking';
      add(thinkingEl);
    }
    thinkingEl.textContent = 'agent thinking… (step ' + step + ')';
  }
  function hideThinking() {
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  }

  function renderToolCall(id, name, argsJson) {
        let div = toolEls.get(id);
        if (!div) {
            div = document.createElement('div');
            div.className = 'tool collapsed';
            add(div);
            toolEls.set(id, div);
        }
                const existingResults = Array.from(div.querySelectorAll('.res'));
                const shouldCollapse = div.classList.contains('collapsed') || !div.querySelector('pre');
                div.className = 'tool' + (shouldCollapse ? ' collapsed' : '');
                while (div.firstChild) { div.removeChild(div.firstChild); }
                const head = document.createElement('div');
                head.className = 'head';
                head.textContent = (div.classList.contains('collapsed') ? '▸' : '▾') + ' tool: ' + name;
                const pre = document.createElement('pre');
                pre.textContent = argsJson;
                div.appendChild(head);
                div.appendChild(pre);
                existingResults.forEach((res) => div.appendChild(res));
    head.addEventListener('click', () => {
      div.classList.toggle('collapsed');
            head.textContent = (div.classList.contains('collapsed') ? '▸' : '▾') + ' tool: ' + name;
    });
  }

  function renderToolResult(id, ok, text) {
        let div = toolEls.get(id);
        if (!div) {
            div = document.createElement('div');
            div.className = 'tool';
            const head = document.createElement('div');
            head.className = 'head';
            head.textContent = 'tool result: pending call metadata';
            div.appendChild(head);
            add(div);
            toolEls.set(id, div);
        }
    const res = document.createElement('div');
    res.className = 'res' + (ok ? '' : ' error');
    res.textContent = (ok ? '✓ result: ' : '✗ error: ') + text;
    div.appendChild(res);
  }

  function renderQuestion(cardId, question, options, allowFreeform, multiSelect) {
    const card = document.createElement('div');
    card.className = 'question-card';
    const q = document.createElement('div');
    q.className = 'q';
    q.textContent = question;
    card.appendChild(q);

    const checks = [];
    options.forEach((opt, i) => {
            opt = typeof opt === 'string' ? { label: opt } : (opt || {});
      const lbl = document.createElement('label');
      lbl.className = 'opt' + (opt.recommended ? ' recommended' : '');
      const inp = document.createElement('input');
      inp.type = multiSelect ? 'checkbox' : 'radio';
      inp.name = cardId;
      inp.value = opt.label;
      lbl.appendChild(inp);
      const text = document.createElement('span');
      text.textContent = ' ' + opt.label;
      lbl.appendChild(text);
      if (opt.description) {
        const d = document.createElement('div');
        d.className = 'desc';
        d.textContent = opt.description;
        lbl.appendChild(d);
      }
      card.appendChild(lbl);
      checks.push(inp);
    });

    let textarea = null;
    if (allowFreeform) {
      const nuanceLabel = document.createElement('div');
      nuanceLabel.className = 'nuance-label';
      nuanceLabel.textContent = '💬 Add nuance (optional):';
      card.appendChild(nuanceLabel);
      textarea = document.createElement('textarea');
      textarea.placeholder = 'Or type your own answer…';
      textarea.rows = 3;
      card.appendChild(textarea);
    }
    const btn = document.createElement('button');
    btn.className = 'submit';
    btn.textContent = 'Submit';
    btn.addEventListener('click', () => {
      const selected = checks.filter(c => c.checked).map(c => c.value);
      const freeform = textarea ? textarea.value.trim() : '';
            const selectedText = selected.join('\n');
            const answer = selectedText && freeform ? selectedText + '\n\n' + freeform : (selectedText || freeform);
      btn.disabled = true;
      btn.textContent = 'Submitted';
      vscode.postMessage({ type: 'questionAnswer', cardId, answer });
    });
    card.appendChild(btn);
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'submit';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            btn.disabled = true;
            cancelBtn.disabled = true;
            cancelBtn.textContent = 'Cancelled';
            vscode.postMessage({ type: 'questionAnswer', cardId, answer: 'user cancelled' });
        });
        card.appendChild(cancelBtn);
    add(card);
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

    window.addEventListener('message', (e) => {
        const m = e.data;
        try {
        if (m.type === 'reply') { hideThinking(); addMessage(m.text, 'assistant'); }
        else if (m.type === 'error') { hideThinking(); addMessage(m.text, 'error'); }
        else if (m.type === 'info') { addMessage(m.text, 'info'); }
        else if (m.type === 'thinking') { showThinking(m.step); }
        else if (m.type === 'thinkingDone') { hideThinking(); }
        else if (m.type === 'toolCall') { renderToolCall(m.id, m.name, m.argsJson); }
        else if (m.type === 'toolResult') { renderToolResult(m.id, m.ok, m.text); }
        else if (m.type === 'askQuestion') { renderQuestion(m.cardId, m.question, m.options || [], m.allowFreeform, m.multiSelect); }
        else if (m.type === 'profileChanged') { profileEl.textContent = m.profile; }
        else if (m.type === 'backendStatus') {
            statusEl.textContent = m.ok ? (m.detail || 'ready') : (m.detail || 'offline');
      statusEl.className = m.ok ? 'ok' : 'bad';
    }
        } catch (error) {
            console.error('Harmony chat render error', error, m);
            addMessage('Harmony UI render error: ' + (error && error.message ? error.message : String(error)), 'error');
        }
  });

    vscode.postMessage({ type: 'ready' });
    vscode.postMessage({ type: 'ping' });
</script>
</body>
</html>`;
    }
}
