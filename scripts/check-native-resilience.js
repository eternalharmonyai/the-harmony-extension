#!/usr/bin/env node
/**
 * Gate: Gemini Native Post-Ask Resilience, Anti-Imitation History & Textual Tool-Call Guard
 *
 * Verifies all 4 pillars of the post-`harmony_ask_question` fix:
 *   1. Exact reproduction of assistant's 3-call `[Tool call: ...]` output recovers all 3
 *      advertised Harmony tool calls cleanly and strips raw `[Tool call: ...]` prose.
 *   2. Code fences (``` / ~~~) and inline backticks never false-trigger textual recovery,
 *      while unadvertised/read-only tools and truncated JSON are safely blocked.
 *   3. Replayed history hygiene strips prior `[Tool call: ...]` & fallback banners, and
 *      unsigned historical tool calls never serialize `[Tool call: fn({...})]` in model turns.
 *   4. `callGeminiNativeStreaming` self-heals stale keep-alive sockets (`Connection: close` +
 *      onGuardEvent ledger callback), enforces `ttfbTimeoutMs` & `streamIdleTimeoutMs`,
 *      `classifyTransient` unwraps `error.cause` chains, and `chatParticipant.ts` checks
 *      `isTransientProviderInterruption` BEFORE `tryCompatFallbackOrRethrow`.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');

const vscodeStub = {
    EventEmitter: class EventEmitter {
        constructor() {
            this.event = () => ({ dispose() {} });
        }
        fire() {}
        dispose() {}
    },
    workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({
            get: (_k, def) => def,
        }),
    },
    window: {
        createOutputChannel: (name) => ({
            name,
            append() {},
            appendLine() {},
            clear() {},
            show() {},
            hide() {},
            dispose() {},
        }),
        showWarningMessage: () => Promise.resolve(undefined),
    },
};

const origLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') return vscodeStub;
    return origLoad.call(this, request, parent, isMain);
};

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
    if (condition) {
        passed += 1;
        console.log(`  PASS  ${label}`);
    } else {
        failed += 1;
        console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    }
}

async function main() {
    console.log('\n[check-native-resilience] Verifying Gemini Native resilience & textual tool-call guard...');

    const guardModPath = path.join(root, 'out', 'textualToolCallGuard.js');
    const geminiModPath = path.join(root, 'out', 'geminiNativeStreaming.js');
    const resilienceModPath = path.join(root, 'out', 'resilience.js');

    check(
        'compiled modules exist (textualToolCallGuard, geminiNativeStreaming, resilience)',
        fs.existsSync(guardModPath) && fs.existsSync(geminiModPath) && fs.existsSync(resilienceModPath),
        'run npm run compile first'
    );
    if (!fs.existsSync(guardModPath)) process.exit(1);

    const {
        extractTextualToolCalls,
        hasTextualToolCallSyntax,
        stripTextualToolCallsFromHistory,
        formatDegradedHistoricalToolSummary,
    } = require(guardModPath);
    const {
        convertMessagesToGeminiContents,
        callGeminiNativeStreaming,
    } = require(geminiModPath);
    const { classifyTransient } = require(resilienceModPath);

    // ── 1. Exact reproduction of assistant's 3-call textual output ───────
    {
        const assistantSample = [
            "Let's lay out our plan in `harmony_todo` first and verify the exact diff before committing Step 1.",
            '[Tool call: harmony_todo({"action":"add","items":["Commit verified Vertex AI auth + Renderer OOM Shield slice cleanly to git","Design & implement Vertex GCP vs AI Studio cost/credit split in costTracker.ts + GCP Vertex billing/quota probe in cloudConnectorTools.ts","Advance Sovereign Gems / Harmony Chat workstream (Option 4) while soak-testing Carbon + OOM Shield","Test Hydrogen & Argon on Vertex AI after sustained OOM Shield soak test"]})]',
            '[Tool call: harmony_git_diff({"stat":true})]',
            '[Tool call: harmony_git_status({})]',
        ].join('\n');

        const allowed = ['harmony_todo', 'harmony_git_diff', 'harmony_git_status'];
        const res = extractTextualToolCalls(assistantSample, allowed, 'step5');

        check(
            'Recovers all 3 advertised tool calls from exact live reproduction with clean prose',
            res.hasAnyTextualToolCallSyntax === true &&
                res.unrecoverableMatches.length === 0 &&
                res.recoveredCalls.length === 3 &&
                res.recoveredCalls[0].function.name === 'harmony_todo' &&
                JSON.parse(res.recoveredCalls[0].function.arguments).items.length === 4 &&
                res.recoveredCalls[1].function.name === 'harmony_git_diff' &&
                JSON.parse(res.recoveredCalls[1].function.arguments).stat === true &&
                res.recoveredCalls[2].function.name === 'harmony_git_status' &&
                !res.cleanedContent.includes('[Tool call:') &&
                res.cleanedContent.includes('`harmony_todo`'),
            JSON.stringify(res)
        );
    }

    // ── 2. Code-fence & inline-backtick immunity + security blocking ─────
    {
        const docSample = [
            'Earlier we saw `[Tool call: harmony_git_status({})]` in text, and inside a block:',
            '```text',
            '[Tool call: harmony_todo({"action":"add","items":["example"]})]',
            '```',
        ].join('\n');

        check(
            'Ignores `[Tool call: ...]` inside inline backticks and fenced code blocks',
            hasTextualToolCallSyntax(docSample) === false &&
                extractTextualToolCalls(docSample, ['harmony_todo', 'harmony_git_status']).recoveredCalls.length === 0
        );

        const blocked = extractTextualToolCalls(
            'Trying write:\n[Tool call: harmony_write_file({"path":"a.txt","content":"x"})]',
            ['harmony_read_file'] // read-only mode: harmony_write_file NOT advertised
        );
        check(
            'Blocks unadvertised/read-only-disallowed tool in `[Tool call: ...]` while cleaning prose',
            blocked.recoveredCalls.length === 0 &&
                blocked.unrecoverableMatches.length === 1 &&
                blocked.unrecoverableMatches[0].reason === 'disallowed_tool' &&
                !blocked.cleanedContent.includes('[Tool call:')
        );

        const truncated = extractTextualToolCalls(
            'Interrupted:\n[Tool call: harmony_read_file({"path":"unclosed',
            ['harmony_read_file']
        );
        check(
            'Flags truncated JSON in `[Tool call: ...]` as invalid_json and strips broken line',
            truncated.recoveredCalls.length === 0 &&
                truncated.unrecoverableMatches.length === 1 &&
                truncated.unrecoverableMatches[0].reason === 'invalid_json' &&
                truncated.cleanedContent === 'Interrupted:'
        );
    }

    // ── 3. Replayed history hygiene & non-imitable unsigned history ──────
    {
        const dirtyHistory = [
            'Step summary.',
            '',
            '> _([Gemini native path unavailable — using compat fallback](debug:gemini-native-fallback))_',
            '',
            '[Tool call: harmony_git_status({})]',
        ].join('\n');
        const cleanedHistory = stripTextualToolCallsFromHistory(dirtyHistory);
        check(
            'stripTextualToolCallsFromHistory removes fallback banner and `[Tool call: ...]` from prior turns',
            cleanedHistory === 'Step summary.'
        );

        const converted = convertMessagesToGeminiContents([
            {
                role: 'assistant',
                content: 'Checking files.',
                tool_calls: [
                    { id: 'call_1', type: 'function', function: { name: 'harmony_list_dir', arguments: '{}' } },
                ],
                // Deliberately unsigned historical tool call
            },
            {
                role: 'tool',
                tool_call_id: 'call_1',
                content: 'src/',
            },
        ]);
        const allModelTexts = converted.contents
            .filter((c) => c.role === 'model')
            .flatMap((c) => c.parts.map((p) => p.text || ''));
        check(
            'Unsigned historical tool calls never emit `[Tool call:` syntax in model turns',
            allModelTexts.length > 0 &&
                allModelTexts.every((t) => !t.includes('[Tool call:')) &&
                formatDegradedHistoricalToolSummary(['harmony_list_dir']).includes('harmony_list_dir')
        );

        // Post-tool Mid-Session Whisper / Flow-State user message must NOT mix `{ text }`
        // sibling parts into a signed `functionResponse` turn (Vertex AI HTTP 400 guard).
        const signedWithPostToolWhisper = convertMessagesToGeminiContents([
            { role: 'user', content: 'Please check status and ask me.' },
            {
                role: 'assistant',
                content: 'Confirming at this checkpoint!',
                tool_calls: [
                    {
                        id: 'call_ask_1',
                        type: 'function',
                        function: { name: 'harmony_ask_question', arguments: '{"question":"Proceed?"}' },
                        thought_signature: 'sig_vertex_valid_123',
                    },
                ],
            },
            {
                role: 'tool',
                tool_call_id: 'call_ask_1',
                content: 'Yes — proceed',
            },
            {
                role: 'user',
                content: '📥 MID-SESSION WHISPER: Why did compat fallback fire around ask_question?',
            },
        ]);
        const finalUserTurn = signedWithPostToolWhisper.contents[signedWithPostToolWhisper.contents.length - 1];
        const allPartsAreFnResponse =
            finalUserTurn &&
            finalUserTurn.role === 'user' &&
            finalUserTurn.parts.length === 1 &&
            Boolean(finalUserTurn.parts[0].functionResponse) &&
            !('text' in finalUserTurn.parts[0]) &&
            String(finalUserTurn.parts[0].functionResponse.response.additional_user_context || '').includes('MID-SESSION WHISPER');
        check(
            'Post-tool user whispers/nudges fold into functionResponse without mixing sibling {text} parts (Vertex 400 guard)',
            allPartsAreFnResponse,
            JSON.stringify(finalUserTurn)
        );
    }

    // ── 4. Stale keep-alive socket self-heal, TTFB guard & stream-idle guard ──
    {
        const cancelToken = {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose() {} }),
        };

        // 4a. Stale pooled socket fails on attempt 1 -> immediate self-heal on attempt 2 with Connection: close
        let fetchCalls = 0;
        let secondCallHeaders = null;
        const guardEvents = [];
        const ssePayload =
            'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Resumed cleanly after ask_question!"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":6}}\n\n';

        const healResult = await callGeminiNativeStreaming(
            'gemini-4-carbon',
            'AIzaTestKey1234567890',
            [{ role: 'user', content: 'Continue' }],
            [],
            cancelToken,
            () => {},
            {
                ttfbTimeoutMs: 2_000,
                streamIdleTimeoutMs: 2_000,
                onGuardEvent: (reason) => guardEvents.push(reason),
                fetchImpl: async (_url, init) => {
                    fetchCalls += 1;
                    if (fetchCalls === 1) {
                        const err = new TypeError('fetch failed');
                        err.cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
                        throw err;
                    }
                    secondCallHeaders = init.headers;
                    return new Response(ssePayload, {
                        status: 200,
                        headers: { 'Content-Type': 'text/event-stream' },
                    });
                },
            }
        );

        check(
            'callGeminiNativeStreaming self-heals stale keep-alive socket with Connection: close + ledger guard event',
            fetchCalls === 2 &&
                secondCallHeaders &&
                secondCallHeaders.Connection === 'close' &&
                guardEvents.length === 1 &&
                guardEvents[0].includes('UND_ERR_SOCKET') &&
                healResult.content === 'Resumed cleanly after ask_question!'
        );

        // 4b. TTFB timeout aborts stalled connection with explicit timeout message (not generic AbortError)
        let ttfbErr = null;
        try {
            await callGeminiNativeStreaming(
                'gemini-4-carbon',
                'AIzaTestKey1234567890',
                [{ role: 'user', content: 'Stall before headers' }],
                [],
                cancelToken,
                () => {},
                {
                    ttfbTimeoutMs: 60,
                    streamIdleTimeoutMs: 2_000,
                    fetchImpl: (_url, init) =>
                        new Promise((_resolve, reject) => {
                            init.signal.addEventListener('abort', () => {
                                const abortErr = new Error('This operation was aborted');
                                abortErr.name = 'AbortError';
                                reject(abortErr);
                            });
                        }),
                }
            );
        } catch (e) {
            ttfbErr = e;
        }
        check(
            'callGeminiNativeStreaming enforces TTFB timeout with clear timeout error',
            Boolean(ttfbErr && /timed out before the first response bytes/i.test(ttfbErr.message)),
            ttfbErr ? ttfbErr.message : 'did not throw'
        );

        // 4c. Mid-stream SSE stall aborts cleanly via streamIdleTimeoutMs
        let idleErr = null;
        try {
            const stallingStream = new ReadableStream({
                start(controller) {
                    controller.enqueue(
                        new TextEncoder().encode(
                            'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Partial..."}]}}]}\n\n'
                        )
                    );
                    // Never close or enqueue again -> triggers idle guard
                },
            });
            await callGeminiNativeStreaming(
                'gemini-4-carbon',
                'AIzaTestKey1234567890',
                [{ role: 'user', content: 'Stall mid-stream' }],
                [],
                cancelToken,
                () => {},
                {
                    ttfbTimeoutMs: 2_000,
                    streamIdleTimeoutMs: 60,
                    fetchImpl: async () => new Response(stallingStream, { status: 200 }),
                }
            );
        } catch (e) {
            idleErr = e;
        }
        check(
            'callGeminiNativeStreaming enforces per-chunk stream idle timeout',
            Boolean(idleErr && /stream idle timeout/i.test(idleErr.message)),
            idleErr ? idleErr.message : 'did not throw'
        );
    }

    // ── 5. Cause-chain transient classifier & chatParticipant retry priority ──
    {
        const undiciErr = new TypeError('fetch failed');
        undiciErr.cause = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
        const v1 = classifyTransient(undiciErr);
        const v2 = classifyTransient(new Error('Gemini Native (gemini-4-carbon) request timed out before the first response bytes (180s).'));
        const v3 = classifyTransient(new Error('HTTP 400 invalid request payload'));
        check(
            'classifyTransient unwraps cause chains & TTFB timeouts while rejecting HTTP 400',
            v1.transient === true &&
                v1.kind === 'transport' &&
                v2.transient === true &&
                v2.kind === 'transport' &&
                v3.transient === false
        );

        const cpSrc = fs.readFileSync(path.join(root, 'src', 'chatParticipant.ts'), 'utf8');
        const transientIdx = cpSrc.indexOf('isTransientProviderInterruption(e) && transientAttempts < MAX_TRANSIENT_ATTEMPTS');
        const compatFallbackIdx = cpSrc.indexOf('const tryCompatFallbackOrRethrow = async');
        check(
            'chatParticipant.ts retries transient interruptions on Gemini Native BEFORE compat fallback',
            transientIdx > 0 &&
                compatFallbackIdx > transientIdx &&
                cpSrc.includes('tryCompatFallbackOrRethrow(e, false)') &&
                cpSrc.includes('extractTextualToolCalls('),
            `transientIdx=${transientIdx}, compatFallbackIdx=${compatFallbackIdx}`
        );
    }

    console.log(`\n[check-native-resilience] ${passed} passed, ${failed} failed.`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error('[check-native-resilience] Fatal error:', err);
    process.exit(1);
});
