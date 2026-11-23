#!/usr/bin/env node
/**
 * Gate: VS Code Renderer Memory Shield (OOM -536870904 / 0xE0000008 Protection)
 *
 * Verifies:
 *   1. BoundedOutputChannel lazy singleton creation, .dispose() no-op protection,
 *      .disposeForShutdown() release, 64 KB single-write cap + visible notice + guard event,
 *      and 512 KB ring rotation + visible banner + guard event (AGENTS.md §6).
 *   2. CoalescedMarkdownStreamer sub-frame token coalescing (~25 fps), exact character &
 *      whitespace preservation, maxBufferChars safety flush, emitImmediate strict ordering,
 *      and synchronous dispose() flush guarantee.
 *   3. cleanup.ts SAFETY_DIRS excludes heavy backup/hygiene trees ('backups', 'hygiene'),
 *      and getContextHealthSize() caches within TTL and refreshes on invalidateContextHealthCache().
 *   4. Static invariants across geminiNativeStreaming.ts, chatParticipant.ts, .vscode/settings.json,
 *      and .vscodeignore (no per-step OutputChannel churn, Gemini/Vertex retry parity, and
 *      live .harmony/inbox watcher preservation).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');

// Minimal vscode stub so compiled modules (out/cleanup.js) can be loaded in pure Node.
let activeWorkspaceFolders = [];
const vscodeStub = {
    Disposable: class Disposable {
        constructor(fn) { this._fn = fn; }
        dispose() { if (this._fn) this._fn(); }
    },
    Uri: {
        file: (fsPath) => ({ fsPath }),
        joinPath: (base, ...segments) => ({ fsPath: path.join(base.fsPath, ...segments) }),
    },
    workspace: {
        get workspaceFolders() {
            return activeWorkspaceFolders;
        },
        getConfiguration: () => ({
            get: (_k, def) => def,
        }),
        fs: {
            async createDirectory(uri) {
                await fs.promises.mkdir(uri.fsPath, { recursive: true });
            },
            async readFile(uri) {
                return fs.promises.readFile(uri.fsPath);
            },
            async writeFile(uri, data) {
                await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
                await fs.promises.writeFile(uri.fsPath, Buffer.from(data));
            },
        },
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
    console.log('\n[check-renderer-shield] Verifying VS Code Renderer Memory Shield...');

    const shieldPath = path.join(root, 'out', 'rendererShield.js');
    const cleanupPath = path.join(root, 'out', 'cleanup.js');
    check(
        'compiled rendererShield.js & cleanup.js exist',
        fs.existsSync(shieldPath) && fs.existsSync(cleanupPath),
        'run npm run compile first'
    );
    if (!fs.existsSync(shieldPath) || !fs.existsSync(cleanupPath)) {
        process.exit(1);
    }

    const {
        createBoundedOutputChannel,
        createCoalescedMarkdownStreamer,
        setRendererGuardListener,
    } = require(shieldPath);
    const {
        SAFETY_DIRS,
        getContextHealthSize,
        invalidateContextHealthCache,
    } = require(cleanupPath);

    // ── 1. BoundedOutputChannel invariants ───────────────────────────────
    {
        let createdCount = 0;
        let disposedCount = 0;
        let clearedCount = 0;
        const lines = [];
        const guardEvents = [];
        const globalEvents = [];
        setRendererGuardListener((ev) => globalEvents.push(ev));

        const ch = createBoundedOutputChannel(
            () => {
                createdCount += 1;
                return {
                    name: 'Harmony Debug Test',
                    append(v) { lines.push(v); },
                    appendLine(v) { lines.push(v + '\n'); },
                    clear() { clearedCount += 1; lines.length = 0; },
                    dispose() { disposedCount += 1; },
                };
            },
            {
                name: 'Harmony Debug Test',
                maxChars: 8_192,
                maxSingleWriteChars: 2_048,
                ignoreDispose: true,
                onGuard: (ev) => guardEvents.push(ev),
            }
        );

        check(
            'BoundedOutputChannel is lazy before first write',
            createdCount === 0 && ch.getStats().channelCreatedCount === 0
        );

        ch.appendLine('step 1 log');
        ch.dispose(); // Simulates legacy per-step caller attempting disposal
        ch.appendLine('step 2 log');

        check(
            'BoundedOutputChannel reuses singleton & ignores accidental .dispose()',
            createdCount === 1 && disposedCount === 0 && ch.getStats().channelCreatedCount === 1
        );

        // Single-write cap (> 2048 chars)
        ch.appendLine('X'.repeat(3_500));
        const combinedAfterTrunc = lines.join('');
        check(
            'BoundedOutputChannel caps oversized single write with visible banner & guard event',
            combinedAfterTrunc.includes('[Harmony Debug write capped at 2048 chars') &&
                guardEvents.some((e) => e.kind === 'debug_write_truncated' && e.originalChars === 3_500) &&
                globalEvents.some((e) => e.kind === 'debug_write_truncated')
        );

        // Ring rotation (> 8192 chars total)
        for (let i = 0; i < 6; i++) {
            ch.appendLine('Y'.repeat(1_800));
        }
        const stats = ch.getStats();
        const combinedAfterRotate = lines.join('');
        check(
            'BoundedOutputChannel ring-rotates buffer at maxChars with visible banner & guard event',
            clearedCount >= 1 &&
                stats.rotationCount >= 1 &&
                stats.bufferedChars <= 8_192 &&
                combinedAfterRotate.includes('Output buffer rotated (#1;') &&
                guardEvents.some((e) => e.kind === 'debug_channel_rotated') &&
                globalEvents.some((e) => e.kind === 'debug_channel_rotated'),
            JSON.stringify(stats)
        );

        ch.disposeForShutdown();
        check(
            'BoundedOutputChannel.disposeForShutdown() releases underlying channel',
            disposedCount === 1
        );
        setRendererGuardListener(undefined);
    }

    // ── 2. CoalescedMarkdownStreamer invariants ──────────────────────────
    {
        // 2a. Rapid sub-frame burst coalesces into 1 batch with 100% lossless text
        const emitted = [];
        const streamer = createCoalescedMarkdownStreamer((md) => emitted.push(md), {
            intervalMs: 35,
            maxBufferChars: 8_192,
        });
        const sampleTokens = [
            '### Heading\n\n',
            'Here is ',
            '`inline code` ',
            'and 中文 / emoji 🌿 ',
            'with\n```ts\nconst x = 42;\n```\n',
        ];
        for (let i = 0; i < 20; i++) {
            for (const tok of sampleTokens) {
                streamer.push(tok);
            }
        }
        const expectedFull = Array.from({ length: 20 }, () => sampleTokens.join('')).join('');
        const batchesBeforeTimer = emitted.length;
        await new Promise((r) => setTimeout(r, 70));
        const stats = streamer.stats();
        streamer.dispose();
        check(
            'CoalescedMarkdownStreamer batches 100 rapid tokens into 1 flush with 100% lossless text',
            batchesBeforeTimer === 0 &&
                emitted.length === 1 &&
                emitted.join('') === expectedFull &&
                stats.pushedChunks === 100 &&
                stats.flushedBatches === 1,
            `batchesBefore=${batchesBeforeTimer}, batchesAfter=${emitted.length}, stats=${JSON.stringify(stats)}`
        );

        // 2b. emitImmediate preserves strict ordering; dispose() flushes synchronously
        const ordered = [];
        const s2 = createCoalescedMarkdownStreamer((md) => ordered.push(md), {
            intervalMs: 200,
            maxBufferChars: 8_192,
        });
        s2.push('Part A ');
        s2.push('Part B');
        s2.emitImmediate('\n\n> _(status notice)_\n\n');
        s2.push('Part C');
        s2.dispose();
        check(
            'CoalescedMarkdownStreamer.emitImmediate & dispose() preserve strict ordering with zero lost text',
            ordered.length === 3 &&
                ordered[0] === 'Part A Part B' &&
                ordered[1] === '\n\n> _(status notice)_\n\n' &&
                ordered[2] === 'Part C',
            JSON.stringify(ordered)
        );

        // 2c. maxBufferChars safety valve flushes immediately without waiting for timer
        const burst = [];
        const s3 = createCoalescedMarkdownStreamer((md) => burst.push(md), {
            intervalMs: 5_000,
            maxBufferChars: 512,
        });
        s3.push('Z'.repeat(600));
        const immediateCount = burst.length;
        s3.dispose();
        check(
            'CoalescedMarkdownStreamer flushes synchronously when maxBufferChars is reached',
            immediateCount === 1 && burst[0].length === 600
        );
    }

    // ── 3. cleanup.ts SAFETY_DIRS & getContextHealthSize TTL cache ───────
    {
        check(
            'SAFETY_DIRS excludes backups & hygiene from context-health byte totals',
            SAFETY_DIRS instanceof Set &&
                SAFETY_DIRS.has('backups') &&
                SAFETY_DIRS.has('hygiene') &&
                SAFETY_DIRS.has('snapshots') &&
                SAFETY_DIRS.has('pre_edit')
        );

        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-shield-test-'));
        try {
            const harmonyDir = path.join(tmpRoot, '.harmony');
            const backupsDir = path.join(harmonyDir, 'backups');
            const sessionsDir = path.join(harmonyDir, 'sessions');
            fs.mkdirSync(backupsDir, { recursive: true });
            fs.mkdirSync(sessionsDir, { recursive: true });
            fs.writeFileSync(path.join(backupsDir, 'huge.bak'), Buffer.alloc(50_000, 0x61));
            fs.writeFileSync(path.join(sessionsDir, 's1.json'), Buffer.alloc(1_200, 0x62));

            activeWorkspaceFolders = [{ uri: { fsPath: tmpRoot } }];
            invalidateContextHealthCache();

            const firstSize = await getContextHealthSize();
            // Add another file inside sessions; within 10s TTL cached value should be served
            fs.writeFileSync(path.join(sessionsDir, 's2.json'), Buffer.alloc(800, 0x63));
            const cachedSize = await getContextHealthSize();
            invalidateContextHealthCache();
            const refreshedSize = await getContextHealthSize();

            check(
                'getContextHealthSize ignores .harmony/backups, serves TTL cache, and updates on invalidation',
                firstSize === 1_200 && cachedSize === 1_200 && refreshedSize === 2_000,
                `first=${firstSize}, cached=${cachedSize}, refreshed=${refreshedSize}`
            );
        } finally {
            activeWorkspaceFolders = [];
            invalidateContextHealthCache();
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    }

    // ── 4. Static Source & Workspace Watcher Shield invariants ───────────
    {
        const geminiSrc = fs.readFileSync(path.join(root, 'src', 'geminiNativeStreaming.ts'), 'utf8');
        check(
            'geminiNativeStreaming.ts has zero per-step createOutputChannel or channel.dispose() calls',
            !geminiSrc.includes('createOutputChannel(') && !geminiSrc.includes('harmonyDebugChannel.dispose(')
        );

        const chatSrc = fs.readFileSync(path.join(root, 'src', 'chatParticipant.ts'), 'utf8');
        check(
            'chatParticipant.ts wires setRendererGuardListener -> recordRouteGuardEvent & CoalescedMarkdownStreamer',
            chatSrc.includes("from './rendererShield'") &&
                chatSrc.includes('setRendererGuardListener(') &&
                chatSrc.includes("recordRouteGuardEvent('vscode-lm', 'native', 'harmony-debug-channel'") &&
                chatSrc.includes('coalescedMarkdown.dispose()') &&
                chatSrc.includes('coalescedLmStream.dispose()') &&
                !chatSrc.includes("callStream(route, apiKey, retryBody") &&
                !chatSrc.includes("callStream(route, apiKey, retryCompatBody")
        );

        const vscodeSettingsPath = path.join(root, '.vscode', 'settings.json');
        const vscodeIgnore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
        const settingsJson = JSON.parse(fs.readFileSync(vscodeSettingsPath, 'utf8'));
        const watcherExclude = settingsJson['files.watcherExclude'] || {};

        check(
            '.vscode/settings.json shields heavy directories while keeping .harmony/inbox watcher live',
            watcherExclude['**/native-ui/src-tauri/target/**'] === true &&
                watcherExclude['**/.fastembed_cache/**'] === true &&
                Object.keys(watcherExclude).some((k) => k.endsWith('/artifacts/**') && watcherExclude[k] === true) &&
                watcherExclude['**/*.vsix'] === true &&
                watcherExclude['**/.harmony/backups/**'] === true &&
                watcherExclude['**/.harmony/diagnostics/**'] === true &&
                watcherExclude['**/.harmony/ask-answers/**'] === true &&
                watcherExclude['**/.harmony/todos-archive.json'] === true &&
                watcherExclude['**/.harmony/**'] !== true &&
                watcherExclude['**/.harmony/inbox/**'] !== true &&
                vscodeIgnore.includes('.vscode/**')
        );

        const deepseekProviderSrc = fs.readFileSync(path.join(root, 'src', 'deepseekProvider.ts'), 'utf8');
        const extSrc = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
        const askViewSrc = fs.readFileSync(path.join(root, 'src', 'askView.ts'), 'utf8');
        const netCheckSrc = fs.readFileSync(path.join(root, 'src', 'networkCheck.ts'), 'utf8');
        const pkgRaw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
        const pkgJson = JSON.parse(pkgRaw);
        const tencentCmdCount = (pkgJson.contributes?.commands || []).filter(
            (c) => c.command === 'harmony.setTencentApiKey'
        ).length;

        check(
            'deepseekProvider.ts coalesces SSE token deltas via createCoalescedMarkdownStreamer & flushes in finally',
            deepseekProviderSrc.includes("from './rendererShield'") &&
                deepseekProviderSrc.includes('createCoalescedMarkdownStreamer(') &&
                deepseekProviderSrc.includes('coalescedText.push(delta.content)') &&
                deepseekProviderSrc.includes('coalescedText.dispose()')
        );

        check(
            'Harmony Hub, Harmony Ask, and Harmony Network Check OutputChannels are bounded via createBoundedOutputChannel',
            extSrc.includes("createBoundedOutputChannel(\n    () => vscode.window.createOutputChannel('Harmony Hub')") ||
                (extSrc.includes('createBoundedOutputChannel(') &&
                    extSrc.includes("createOutputChannel('Harmony Hub')") &&
                    extSrc.includes('hubOutput.disposeForShutdown()') &&
                    askViewSrc.includes('createBoundedOutputChannel(') &&
                    netCheckSrc.includes('createBoundedOutputChannel('))
        );

        check(
            'chatParticipant.ts bounds vscode-lm chatContext.history replay & logs vscode_lm_history_trimmed guard event',
            chatSrc.includes('vscode_lm_history_trimmed') &&
                chatSrc.includes('[vscode-lm History] replayed=')
        );

        check(
            'package.json declares harmony.setTencentApiKey exactly once (zero duplicate registration noise)',
            tencentCmdCount === 1,
            `count=${tencentCmdCount}`
        );
    }

    // ── 5. Bounded Todo Active Window + Reversible Auto-Archival + Scoped Verifier ──
    {
        const todoStore = require(path.join(root, 'out', 'todoStore.js'));
        const verifier = require(path.join(root, 'out', 'verifier.js'));
        const tmpTodoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-todo-shield-'));
        try {
            activeWorkspaceFolders = [{ uri: { fsPath: tmpTodoRoot } }];
            const batch = Array.from({ length: 18 }, (_, i) => `Task item #${i + 1}`);
            const added = await todoStore.addTodos(batch);

            // Check off 7 items -> 4 kept in todo.json, 3 overflow completed archived to todos-archive.json
            let latest = added;
            for (let i = 0; i < 7; i++) {
                latest = await todoStore.checkTodo(added[i].id, true);
            }
            const archivePath = path.join(tmpTodoRoot, '.harmony', 'todos-archive.json');
            const archiveItems = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
            const doneRemaining = latest.filter((t) => t.done);
            check(
                'todoStore auto-archives overflow completed items to .harmony/todos-archive.json (keeps 4 recent done)',
                archiveItems.length === 3 && doneRemaining.length === 4,
                `archived=${archiveItems.length}, doneRemaining=${doneRemaining.length}`
            );

            // Add 5 more pending items so pending = 16 (> 11 active window)
            const more = await todoStore.addTodos(['Newest A', 'Newest B', 'Newest C', 'Newest D', 'Newest E']);
            const formatted = todoStore.formatActiveWindowTodos(more, 11, 4);
            check(
                'formatActiveWindowTodos shows newest active items + Rule 6 omission disclosure',
                formatted.includes('Newest E') &&
                    !formatted.includes('Task item #8 ') &&
                    formatted.includes('[Active window: showing 15 of 20 todo(s); 5 older pending omitted'),
                formatted.split('\n').slice(-2).join(' | ')
            );

            const smallFormatted = todoStore.formatActiveWindowTodos(more.slice(-4), 11, 4);
            check(
                'formatActiveWindowTodos omits disclosure notice when all items fit active window',
                !smallFormatted.includes('[Active window:')
            );

            const verifierReport = await verifier.runVerifierCheck();
            check(
                'runVerifierCheck scopes to active todo window & discloses omitted backlog count (Rule 6)',
                verifierReport.includes('11 active pending todo(s)') &&
                    verifierReport.includes('5 older backlog item(s) omitted to protect VS Code Renderer memory') &&
                    verifierReport.includes('Newest E') &&
                    !verifierReport.includes('Task item #8'),
                verifierReport.split('\n').slice(0, 4).join(' | ')
            );

            // Concurrent mutation race test (withTodoLock)
            await Promise.all([
                todoStore.addTodos(['Parallel 1']),
                todoStore.addTodos(['Parallel 2']),
                todoStore.addTodos(['Parallel 3']),
            ]);
            const afterParallel = await todoStore.loadTodos();
            const parallelTexts = new Set(afterParallel.map((t) => t.text));
            check(
                'withTodoLock serializes concurrent addTodos calls with zero lost writes',
                parallelTexts.has('Parallel 1') && parallelTexts.has('Parallel 2') && parallelTexts.has('Parallel 3'),
                `total=${afterParallel.length}`
            );
        } finally {
            activeWorkspaceFolders = [];
            fs.rmSync(tmpTodoRoot, { recursive: true, force: true });
        }
    }

    // ── 6. Renderer OOM Shield v3: ChatResult.metadata Diet + Read-Only/Fleet Payload Isolation ──
    {
        const shieldMod = require(path.join(root, 'out', 'rendererShield.js'));
        const auditScopeMod = require(path.join(root, 'out', 'auditScope.js'));
        const chatSrc = fs.readFileSync(path.join(root, 'src', 'chatParticipant.ts'), 'utf8');
        const lmToolsSrc = fs.readFileSync(path.join(root, 'src', 'lmTools.ts'), 'utf8');
        const settingsJson = JSON.parse(fs.readFileSync(path.join(root, '.vscode', 'settings.json'), 'utf8'));
        const watcherExclude = settingsJson['files.watcherExclude'] || {};

        const hugeEditInput = {
            path: 'src/host/standaloneServer.ts',
            old_string: 'A'.repeat(90_000),
            new_string: 'B'.repeat(90_000),
            tasks: [{ prompt: 'C'.repeat(40_000) }],
        };
        const slimWrite = shieldMod.compactUsageCallRecord('harmony_edit_file', hugeEditInput, {
            resultChars: 160_000,
        });
        const slimRead = shieldMod.compactUsageCallRecord('harmony_read_file', { path: 'README.md' }, {
            resultChars: 48_000,
        });
        const slimJson = JSON.stringify([slimWrite, slimRead]);
        const scope = auditScopeMod.classifyToolCallReferences([slimWrite, slimRead]);

        check(
            'compactUsageCallRecord strips 90KB–160KB inputs/results (<512 bytes) while preserving classifyToolCallReferences path accuracy',
            slimJson.length < 512 &&
                !('result' in slimWrite) &&
                !('old_string' in (slimWrite.input || {})) &&
                slimWrite.resultChars === 160_000 &&
                scope.paths.length === 1 &&
                scope.paths[0] === 'src/host/standaloneServer.ts' &&
                scope.readOnlyExcluded.includes('README.md'),
            `slimBytes=${slimJson.length}, paths=${JSON.stringify(scope.paths)}`
        );

        check(
            'chatParticipant.ts uses compactUsageCallRecord & omits toolInvocationToken on read-only/Fleet tools; ParallelTool spills full worker outputs to .harmony/fleet/',
            chatSrc.includes('compactUsageCallRecord(') &&
                !chatSrc.includes('usageCalls.push({ name: r.call.function.name, input: r.input, result: r.resultText })') &&
                chatSrc.includes('rendererShield.omitReadOnlyInvocationToken') &&
                chatSrc.includes('isReadOnlyTool(toolName)') &&
                lmToolsSrc.includes('.harmony/fleet/fleet-') &&
                watcherExclude['**/.harmony/fleet/**'] === true
        );
    }

    console.log(`\n[check-renderer-shield] ${passed} passed, ${failed} failed.`);
    if (failed > 0) {
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('[check-renderer-shield] Fatal error:', err);
    process.exit(1);
});
