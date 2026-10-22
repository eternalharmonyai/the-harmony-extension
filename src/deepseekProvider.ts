/**
 * DeepSeek Language Model Chat Provider for VS Code Copilot Chat.
 *
 * Registers deepseek-flash (V4.1), deepseek-v4-flash, deepseek-v4-pro, and deepseek-v4-flash-vision-exp
 * as native models in Copilot Chat's model picker. All requests go directly to DeepSeek API
 * — no TLS interception, no DNS hacking, no rate limits.
 *
 * This file is ISOLATED at registration: if the LM API is missing, the catch in
 * extension.ts reports it and Harmony continues. It imports only recordUsage from
 * costTracker for ledger parity — a compile-time link to an always-loaded module.
 * If it fails, it just doesn't register — Harmony works as before.
 *
 * ALSO REQUIRES: package.json contribution point "languageModelChatProviders"
 */
import * as vscode from 'vscode';
import { recordUsage } from './costTracker';
import {
    ToolCallAccumulator,
    buildChatMessages,
    toOpenAiTools,
    NormalizedMessage,
    NormalizedPart,
} from './deepseekToolBridge';

const VENDOR = 'deepseek';
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

/** First-byte (TTFB) budget in ms from harmony.ttfbTimeoutSec. This file is
 *  deliberately import-isolated (see header) — a local twin of the chat seat's
 *  helper rather than an import from chatParticipant.ts. 180s default: heavy
 *  reasoning models can think for minutes before the first streaming token.
 *  Floor 30 / cap 600 / non-finite → default, so the guard can never be
 *  disabled or stretched absurdly by a stray settings value. */
function ttfbTimeoutMs(): number {
    const sec = vscode.workspace.getConfiguration('harmony').get<number>('ttfbTimeoutSec');
    const effective = (typeof sec === 'number' && Number.isFinite(sec) && sec >= 30) ? Math.min(sec, 600) : 180;
    return effective * 1000;
}

/** Short, server-derived reason from a DeepSeek/OpenAI error body. */
function summarizeRejection(text: string): string {
    if (!text) {
        return 'no response body';
    }
    try {
        const parsed = JSON.parse(text) as { error?: { message?: unknown } };
        const message = parsed.error?.message;
        if (typeof message === 'string' && message.trim().length > 0) {
            return message.trim().slice(0, 300);
        }
    } catch {
        /* not JSON — fall through to the raw slice */
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, 300) || 'no response body';
}

interface DeepSeekModelInfo extends vscode.LanguageModelChatInformation {
    apiModel: string; // actual DeepSeek API model name
}

// Tool calling is supported on these picker models: options.tools is mapped
// and forwarded, streamed delta.tool_calls fragments are reassembled in
// deepseekToolBridge.ts, and LanguageModelToolCallPart events are emitted back
// to VS Code so Agent mode can execute them.
const MODELS: DeepSeekModelInfo[] = [
    {
        id: 'deepseek-flash',
        name: 'DeepSeek Flash (V4.1)',
        family: VENDOR,
        version: 'v4.1-flash',
        maxInputTokens: 1048576,
        maxOutputTokens: 393216,
        capabilities: { toolCalling: true },
        apiModel: 'deepseek-flash',
    },
    {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        family: VENDOR,
        version: 'v4-flash',
        maxInputTokens: 1048576,
        maxOutputTokens: 393216,
        capabilities: { toolCalling: true },
        apiModel: 'deepseek-v4-flash',
    },
    {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        family: VENDOR,
        version: 'v4-pro',
        maxInputTokens: 1048576,
        maxOutputTokens: 393216,
        capabilities: { toolCalling: true },
        apiModel: 'deepseek-v4-pro',
    },
    {
        id: 'deepseek-v4-flash-vision-exp',
        name: 'DeepSeek V4 Flash Vision (exp)',
        family: VENDOR,
        version: 'v4-flash-vision-exp',
        maxInputTokens: 1048576,
        maxOutputTokens: 393216,
        capabilities: { toolCalling: true, imageInput: true },
        apiModel: 'deepseek-v4-flash-vision-exp',
    },
];

/**
 * Extract text content from a LanguageModelChatRequestMessage.
 * Content can be a string (older API) or array of parts.
 */
function extractTextContent(msg: vscode.LanguageModelChatRequestMessage): string {
    const content = msg.content;
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (part instanceof vscode.LanguageModelTextPart) return part.value;
                if (part instanceof vscode.LanguageModelToolCallPart) {
                    return `${part.name} ${JSON.stringify(part.input ?? {})}`;
                }
                if (part instanceof vscode.LanguageModelToolResultPart) {
                    return toolResultPartsToText(part.content);
                }
                if (part && typeof (part as any).value === 'string') return (part as any).value;
                return '';
            })
            .join('\n');
    }
    return String(content);
}

/**
 * Map VS Code message role to DeepSeek role string.
 */
/**
 * Sanitize content for safe JSON serialization.
 * Handles lone surrogate pairs and control characters.
 */
function sanitizeContent(str: string): string {
    return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function mapRole(role: vscode.LanguageModelChatMessageRole): string {
    switch (role) {
        case vscode.LanguageModelChatMessageRole.User: return 'user';
        case vscode.LanguageModelChatMessageRole.Assistant: return 'assistant';
        default: return 'user';
    }
}

/**
 * Flatten a VS Code tool-result content array to text.
 */
function toolResultPartsToText(content: readonly unknown[] | undefined): string {
    if (!Array.isArray(content)) return '';
    return content
        .map(part => {
            if (part instanceof vscode.LanguageModelTextPart) return part.value;
            if (part && typeof (part as any).value === 'string') return (part as any).value;
            try { return JSON.stringify(part); } catch { return String(part); }
        })
        .filter((text): text is string => typeof text === 'string' && text.trim().length > 0)
        .join('\n');
}

/**
 * Reduce one VS Code request message to the normalized shape the pure tool
 * bridge understands, preserving tool-call and tool-result parts across turns.
 */
function toNormalizedMessage(msg: vscode.LanguageModelChatRequestMessage): NormalizedMessage | undefined {
    const role = mapRole(msg.role);
    if (role !== 'user' && role !== 'assistant') return undefined;

    const parts: NormalizedPart[] = [];
    const media: unknown[] = [];
    const pushText = (text: string) => { if (text.length > 0) parts.push({ kind: 'text', text }); };

    const content = msg.content as unknown;
    if (typeof content === 'string') {
        pushText(sanitizeContent(content));
    } else if (Array.isArray(content)) {
        for (const raw of content) {
            if (!raw || typeof raw !== 'object') continue;
            const part = raw as any;
            if (part instanceof vscode.LanguageModelTextPart) {
                pushText(sanitizeContent(part.value));
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                parts.push({ kind: 'toolCall', callId: part.callId, name: part.name, input: part.input });
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                parts.push({ kind: 'toolResult', callId: part.callId, text: toolResultPartsToText(part.content) });
            } else if (typeof part.mimeType === 'string' && part.data !== undefined) {
                media.push({ mimeType: part.mimeType, data: part.data });
            } else if (typeof part.value === 'string') {
                pushText(sanitizeContent(part.value));
            }
        }
    } else if (content) {
        pushText(sanitizeContent(String(content)));
    }

    return media.length > 0 ? { role, parts, media } : { role, parts };
}

/**
 * Render one normalized message's text as API content. Only the vision model
 * gets a multimodal array; everything else sends plain text so we never hand a
 * non-vision model a shape it will reject.
 */
function makeContentRenderer(model: DeepSeekModelInfo) {
    return (text: string, message: NormalizedMessage): string | unknown[] => {
        const media = message.media ?? [];
        if (model.apiModel !== 'deepseek-v4-flash-vision-exp' || media.length === 0) {
            return text;
        }
        const out: any[] = [];
        if (text.length > 0) out.push({ type: 'text', text });
        for (const item of media) {
            const m = item as { mimeType?: string; data?: unknown };
            const data = typeof m.data === 'string' ? m.data : Buffer.from(m.data as any).toString('base64');
            out.push({ type: 'image_url', image_url: { url: `data:${m.mimeType || 'image/png'};base64,${data}` } });
        }
        return out;
    };
}

export function registerDeepSeekProvider(context: vscode.ExtensionContext) {
    const provider: vscode.LanguageModelChatProvider<DeepSeekModelInfo> = {
        // ── List available models ──────────────────────
        provideLanguageModelChatInformation(
            _options: vscode.PrepareLanguageModelChatModelOptions,
            _token: vscode.CancellationToken
        ): vscode.ProviderResult<DeepSeekModelInfo[]> {
            return MODELS;
        },

        // ── Handle chat requests ───────────────────────
        async provideLanguageModelChatResponse(
            model: DeepSeekModelInfo,
            messages: readonly vscode.LanguageModelChatRequestMessage[],
            options: vscode.ProvideLanguageModelChatResponseOptions,
            progress: vscode.Progress<vscode.LanguageModelResponsePart>,
            token: vscode.CancellationToken
        ): Promise<void> {
            // Get API key
            let apiKey = await context.secrets.get('harmony.deepseekApiKey');
            if (!apiKey) {
                apiKey = process.env.DEEPSEEK_COPILOT_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? '';
            }
            if (!apiKey) {
                progress.report(new vscode.LanguageModelTextPart(
                    '[DeepSeek] ❌ API key not configured.\n\n' +
                    'Set Harmony: Deepseek Api Key in VS Code settings, or run the Harmony "Select Model" command.'
                ));
                return;
            }

            const baseUrl = vscode.workspace.getConfiguration('harmony').get<string>('deepseekBaseUrl') ?? DEEPSEEK_BASE;
            const cleanBase = baseUrl.replace(/\/$/, '');

            // Build DeepSeek API messages. Tool calls and tool results are
            // preserved so multi-step agent turns stay coherent.
            const normalized = messages
                .map(toNormalizedMessage)
                .filter((m): m is NormalizedMessage => m !== undefined);
            const deepseekMessages = buildChatMessages(normalized, makeContentRenderer(model));
            // Only tools VS Code actually offered this request. Undefined (not an
            // empty array) when there are none — some compatible servers reject [].
            const tools = toOpenAiTools(options.tools);

            const cfg = vscode.workspace.getConfiguration('harmony');
            const reasoningEffort = cfg.get<string>('deepseekReasoningEffort') ?? 'high';
            const thinkingEnabled = cfg.get<boolean>('deepseekThinking') ?? true;
            const requestBody: any = {
                model: model.apiModel,
                messages: deepseekMessages,
                stream: true,
                stream_options: { include_usage: true },
                // Bounded budget: 32k per request (advertised max stays 393k). A giant
                // budget on a stalled request is unbounded spend + unbounded silence.
                max_tokens: 32768,
            };
            // Honor the same controls as the Harmony chat seat.
            if (thinkingEnabled) requestBody.thinking = { type: 'enabled' };
            requestBody.reasoning_effort = reasoningEffort;
            // Tool schema for agent mode. Present only when VS Code offered tools.
            if (tools) {
                requestBody.tools = tools;
                requestBody.tool_choice = 'auto';
            }

            // Safe JSON serialization with fallback for edge cases
            let body: string;
            try {
                body = JSON.stringify(requestBody);
            } catch (jsonErr) {
                console.warn('[DeepSeek Provider] JSON.stringify failed, retrying with aggressive sanitization:', jsonErr);
                const safeMessages = deepseekMessages.map(m => ({
                    ...m,
                    content: typeof m.content === 'string'
                        ? m.content.replace(/[\x00-\x1F\x7F-\x9F]/g, '')
                        : m.content,
                }));
                body = JSON.stringify({ ...requestBody, messages: safeMessages });
            }

            const controller = new AbortController();
            const cancelSub = token.onCancellationRequested(() => controller.abort());
            const startedAt = Date.now();
            // TTFB guard: a stalled connect/think before headers must fail loudly
            // instead of hanging the picker request forever. Budget is configurable
            // via harmony.ttfbTimeoutSec (180s default) — heavy reasoners can think
            // for minutes before the first streaming token.
            const ttfMs = ttfbTimeoutMs();
            const ttfGuard = setTimeout(() => controller.abort(new Error(`timed out before the first response bytes (${Math.round(ttfMs / 1000)}s).`)), ttfMs);
            // Per-read idle guard: honors harmony.streamIdleTimeoutSec (120s default,
            // floor 30s — 0/absent mean the default). cfg is read above for the
            // reasoning controls; one config source for the whole request.
            const idleSec = cfg.get<number>('streamIdleTimeoutSec') ?? 120;
            const idleMs = (idleSec >= 30 ? idleSec : 120) * 1000;
            let idleGuard: NodeJS.Timeout | undefined;
            // Hoisted above try so the finally-block ledger entry can see them on
            // every exit path (success, early return, timeout/abort/throw).
            let truncated = false;
            let usage: { promptTokens: number; completionTokens: number } | undefined;
            // Same reason as above: a degraded (tool-less) retry must reach the ledger
            // from every exit path, or a tool-loop outage is indistinguishable from
            // healthy usage in the cost and reliability record.
            let toolsDroppedForRetry = false;
            let rejectionReason: string | undefined;

            try {
                const requestInit = {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                        'Accept': 'text/event-stream'
                    },
                    body: body,
                    signal: controller.signal as AbortSignal,
                };
                let response = await fetch(`${cleanBase}/chat/completions`, requestInit);
                // If the request with tools returns HTTP 400, retry once without
                // tools and surface the actual status/reason.
                if (response.status === 400 && tools) {
                    const firstText = await response.text();
                    rejectionReason = summarizeRejection(firstText);
                    try {
                        const retryBody = JSON.stringify({ ...requestBody, tools: undefined, tool_choice: undefined });
                        const retryResponse = await fetch(`${cleanBase}/chat/completions`, { ...requestInit, body: retryBody });
                        if (retryResponse.ok) {
                            response = retryResponse;
                            toolsDroppedForRetry = true;
                        } else {
                            // Report the RETRY's own status and body. The original 400 is
                            // context, never the headline — this is the line that used to
                            // claim "HTTP 400" no matter what really failed.
                            const retryText = await retryResponse.text();
                            progress.report(new vscode.LanguageModelTextPart(
                                `[DeepSeek] ❌ HTTP ${retryResponse.status} on the retry without tools: ${summarizeRejection(retryText)}\n` +
                                `   (the original request with tools returned HTTP 400: ${rejectionReason})`
                            ));
                            return;
                        }
                    } catch (retryErr) {
                        // An abort, a Stop or a network loss during the retry is NOT an
                        // HTTP 400. Say what actually happened.
                        if (token.isCancellationRequested) {
                            return;
                        }
                        progress.report(new vscode.LanguageModelTextPart(
                            `[DeepSeek] ❌ the retry without tools did not complete: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}\n` +
                            `   (the original request with tools returned HTTP 400: ${rejectionReason})`
                        ));
                        return;
                    }
                }
                clearTimeout(ttfGuard); // headers arrived — hand the budget to the idle guard

                if (!response.ok) {
                    const text = await response.text();
                    progress.report(new vscode.LanguageModelTextPart(
                        `[DeepSeek] ❌ HTTP ${response.status}: ${text.slice(0, 500)}`
                    ));
                    return;
                }
                if (!response.body) {
                    progress.report(new vscode.LanguageModelTextPart('[DeepSeek] ❌ empty response body.'));
                    return;
                }

                // 🎀 Foolproof ribbon first, then progressive content parts (VS Code appends parts in order).
                progress.report(new vscode.LanguageModelTextPart(`[DeepSeek ${model.apiModel}] `));
                if (toolsDroppedForRetry) {
                    progress.report(new vscode.LanguageModelTextPart(
                        `(answered WITHOUT tools — the request with tools was rejected: ${rejectionReason ?? 'reason unknown'})\n`
                    ));
                }

                const reader = (response.body as any).getReader();
                const decoder = new TextDecoder('utf-8');
                let buffer = '';
                let sawContent = false;
                let reportedThinking = false;
                // Tool calls arrive as fragments spread across many SSE chunks.
                const gatheredToolCalls = new ToolCallAccumulator();

                while (true) {
                    if (token.isCancellationRequested) break;
                    idleGuard = setTimeout(() => controller.abort(new Error(`stream idle for ${Math.round(idleMs / 1000)}s — stalled.`)), idleMs);
                    const { value, done } = await reader.read();
                    clearTimeout(idleGuard);
                    // On done: final decoder.decode() flush so a multi-byte character
                    // split across the last chunk is not dropped.
                    const chunkText = done ? decoder.decode() : decoder.decode(value, { stream: true });
                    buffer += chunkText;
                    if (buffer.length > 1_000_000) throw new Error('SSE buffer exceeded 1MB — malformed stream.');

                    let lineEnd: number;
                    while ((lineEnd = buffer.indexOf('\n')) >= 0) {
                        const rawLine = buffer.slice(0, lineEnd).trim();
                        buffer = buffer.slice(lineEnd + 1);
                        if (!rawLine || !rawLine.startsWith('data:')) continue;
                        const data = rawLine.slice(5).trim();
                        if (data === '[DONE]') continue;
                        let chunk: any;
                        try { chunk = JSON.parse(data); } catch { continue; }
                        if (chunk?.usage) {
                            usage = {
                                promptTokens: chunk.usage.prompt_tokens ?? 0,
                                completionTokens: chunk.usage.completion_tokens ?? 0
                            };
                        }
                        if (chunk?.choices?.[0]?.finish_reason === 'length') truncated = true;
                        const delta = chunk?.choices?.[0]?.delta;
                        if (!delta) continue;
                        if (delta.tool_calls !== undefined) {
                            gatheredToolCalls.push(delta.tool_calls);
                        }
                        const reasoning = delta.reasoning_content;
                        if (typeof reasoning === 'string' && reasoning) {
                            // Liveness only — NEVER surface raw chain-of-thought. Picker output
                            // enters Copilot Chat history; injecting CoT would corrupt the
                            // next-turn transcript (and this part is permanent, so: one short
                            // indicator, never a ticking one).
                            if (!reportedThinking) {
                                reportedThinking = true;
                                if (!token.isCancellationRequested) {
                                    progress.report(new vscode.LanguageModelTextPart('(thinking…) '));
                                }
                            }
                        }
                        if (typeof delta.content === 'string' && delta.content) {
                            sawContent = true;
                            if (!token.isCancellationRequested) {
                                progress.report(new vscode.LanguageModelTextPart(delta.content));
                            }
                        }
                    }
                    if (done) break;
                }
                // Report gathered tool calls AFTER the streamed text, so VS Code
                // receives the assistant turn in the order the model produced it.
                // Agent mode invokes each LanguageModelToolCallPart itself and
                // sends the results back on the next turn.
                const assembledCalls = gatheredToolCalls.finish();
                for (const call of assembledCalls) {
                    if (token.isCancellationRequested) break;
                    if (call.parseFailed) {
                        progress.report(new vscode.LanguageModelTextPart(
                            `\n[tool ${call.name}] arguments were not valid JSON — sent as an empty object.\n`
                        ));
                    }
                    progress.report(new vscode.LanguageModelToolCallPart(call.callId, call.name, call.input as object));
                }
                if (truncated && !token.isCancellationRequested) {
                    progress.report(new vscode.LanguageModelTextPart('\n… (truncated by the output token limit)'));
                }
                if (!sawContent && assembledCalls.length === 0 && !token.isCancellationRequested) {
                    progress.report(new vscode.LanguageModelTextPart('(no content)'));
                }
            } catch (e) {
                if (token.isCancellationRequested) return;
                progress.report(new vscode.LanguageModelTextPart(
                    `[DeepSeek] ❌ ${e instanceof Error ? e.message : String(e)}`
                ));
            } finally {
                clearTimeout(idleGuard);
                clearTimeout(ttfGuard);
                cancelSub.dispose();
                // Telemetry in finally: records on EVERY exit path — success, the two
                // early returns, and the failure modes (timeout/abort/throw) that made
                // this path ledger-dark in the first place. provider 'deepseek' (not
                // 'vscode-lm') so estimateCost prices it; tier 'native' still marks the
                // picker path distinctly from the chat seat's tiers.
                recordUsage({
                    timestamp: new Date().toISOString(),
                    provider: 'deepseek',
                    tier: 'native',
                    model: model.apiModel,
                    promptTokens: usage?.promptTokens ?? 0,
                    completionTokens: usage?.completionTokens ?? 0,
                    durationMs: Date.now() - startedAt,
                    // Record degraded tool-less retries in the usage ledger.
                    toolsDroppedForRetry,
                    degradationReason: rejectionReason
                });
            }
        },

        // ── Token counting (approximate) ───────────────
        async provideTokenCount(
            _model: DeepSeekModelInfo,
            text: string | vscode.LanguageModelChatRequestMessage,
            _token: vscode.CancellationToken
        ): Promise<number> {
            const str = typeof text === 'string' ? text : extractTextContent(text);
            // ~4 chars per token — DeepSeek uses similar tokenization
            return Math.ceil(str.length / 4);
        },
    };

    context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider(VENDOR, provider)
    );

    console.log('[DeepSeek Provider] ✅ Registered — vendor: deepseek, models: flash (V4.1), v4-flash, v4-pro, v4-flash-vision-exp');

    // ── DIAGNOSTIC (on-demand): verify models actually landed in the LM registry ──
    // Queries the same registry the model picker reads, then surfaces the
    // result as a visible message (exthost.log does not capture console.log).
    // Runs ONLY when invoked as "Harmony: LM Check" from the command palette —
    // no popup on every activation.
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.lmCheck', async () => {
            try {
                const apiOk = typeof (vscode.lm as any).registerLanguageModelChatProvider === 'function';
                const mine = await vscode.lm.selectChatModels({ vendor: VENDOR });
                const all = await vscode.lm.selectChatModels({});
                const summary =
                    `API ${apiOk ? '✅' : '❌'} | deepseek models: ${mine.length}` +
                    `${mine.length ? ' (' + mine.map(m => m.id).join(', ') + ')' : ''}` +
                    ` | total registry: ${all.length}`;
                console.log('[DeepSeek Provider] DIAG:', summary);
                vscode.window.showInformationMessage(`Harmony LM check → ${summary}`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.error('[DeepSeek Provider] DIAG FAILED:', msg);
                vscode.window.showErrorMessage(`Harmony LM check FAILED → ${msg}`);
            }
        })
    );
}
