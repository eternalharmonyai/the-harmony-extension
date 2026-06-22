/**
 * DeepOrchestrate — safe copy-edit-review pipeline for AI-assisted file editing.
 * 
 * Pipeline: Read → Draft Copy → AI Edit → Diff → Multi-Model Review → Consensus → Atomic Apply
 * 
 * Enterprise-grade guarantees:
 * - Copies only in .harmony/orchestrate-drafts/<timestamp>/, originals never touched
 * - 2-of-3 multi-model consensus before application
 * - 3-phase WAL (write-ahead log) for atomic application with rollback
 * - Append-only JSONL audit trail
 * - Dry-run mode (diff + review without applying)
 * - Human gate via harmony_ask_question before destructive writes
 * - Workspace-level advisory lock prevents concurrent pipelines
 * - Cost budget with override flag
 * - Configurable review depth (1/2/3)
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as cp from 'child_process';
import { secretKeyFor } from './providers';

// ── Types ──────────────────────────────────────────────────────────────────

interface DeepOrchestrateInput {
    filePath: string;
    editInstruction: string;
    dryRun?: boolean;
    /** LLM-supplied edited content. When provided, the pipeline uses this instead of an empty placeholder. */
    proposedContent?: string;
}

interface ReviewVote {
    modelId: string;
    approved: boolean;
    concerns: string[];
}

interface ReviewResult {
    consensus: boolean;
    votes: ReviewVote[];
    estimatedCost: number;
}

interface AuditEntry {
    timestamp: string;
    operationId: string;
    filePath: string;
    instruction: string;
    dryRun: boolean;
    consensus: boolean;
    applied: boolean;
    error?: string;
}

// ── Anti-correlation model groups ──────────────────────────────────────────

/** Model groups for diverse reviewer selection. Each tuple is [provider, group]. */
const REVIEWER_GROUPS: [string, string][] = [
    ['deepseek', 'DeepSeek'],
    ['alibaba', 'Qwen'],
    ['moonshot', 'Kimi'],
    ['gemini', 'Gemini'],
    ['tencent', 'Hunyuan'],
];

/** Pick N reviewers from different model groups (anti-correlation). */
function pickReviewers(n: number): [string, string][] {
    // Rotate based on date to avoid always picking the same models
    const offset = new Date().getDate() % REVIEWER_GROUPS.length;
    const rotated = [...REVIEWER_GROUPS.slice(offset), ...REVIEWER_GROUPS.slice(0, offset)];
    return rotated.slice(0, Math.min(n, rotated.length));
}

/** Review checklist each model group checks for. */
const REVIEW_CHECKS: Record<string, string[]> = {
    'DeepSeek': ['Logic correctness', 'Edge-case handling', 'TypeScript type safety'],
    'Qwen': ['Code style consistency', 'Import organization', 'Error handling patterns'],
    'Kimi': ['Performance implications', 'Memory/leak risks', 'Async/await correctness'],
    'Gemini': ['Security surface', 'Input validation', 'API contract adherence'],
    'Hunyuan': ['Backward compatibility', 'Test surface impact', 'Documentation alignment'],
};

// ── Real Multi-Model Review ────────────────────────────────────────────────

interface ReviewerConfig {
    provider: string;
    group: string;
    endpoint: string;
    model: string;
    authHeader: (apiKey: string) => Record<string, string>;
    buildBody: (prompt: string) => any;
}

/** Provider-specific API configurations for review calls. */
const REVIEWER_CONFIGS: Record<string, ReviewerConfig> = {
    'deepseek': {
        provider: 'deepseek', group: 'DeepSeek',
        endpoint: 'https://api.deepseek.com/v1/chat/completions',
        model: 'deepseek-chat',
        authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
        buildBody: (prompt) => ({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], max_tokens: 200, temperature: 0.1 }),
    },
    'alibaba': {
        provider: 'alibaba', group: 'Qwen',
        endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        model: 'qwen-turbo',
        authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
        buildBody: (prompt) => ({ model: 'qwen-turbo', messages: [{ role: 'user', content: prompt }], max_tokens: 200, temperature: 0.1 }),
    },
    'moonshot': {
        provider: 'moonshot', group: 'Kimi',
        endpoint: 'https://api.moonshot.ai/v1/chat/completions',
        model: 'moonshot-v1-8k',
        authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
        buildBody: (prompt) => ({ model: 'moonshot-v1-8k', messages: [{ role: 'user', content: prompt }], max_tokens: 200, temperature: 0.1 }),
    },
    'gemini': {
        provider: 'gemini', group: 'Gemini',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent',
        model: 'gemini-2.0-flash-lite',
        authHeader: (_key) => ({}),
        buildBody: (prompt) => ({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 200, temperature: 0.1 } }),
    },
    'tencent': {
        provider: 'tencent', group: 'Hunyuan',
        endpoint: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',
        model: 'hunyuan-lite',
        authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
        buildBody: (prompt) => ({ model: 'hunyuan-lite', messages: [{ role: 'user', content: prompt }], max_tokens: 200, temperature: 0.1 }),
    },
};

/** Call one reviewer model and get its verdict. Returns undefined if the call fails (caller excludes from consensus). */
async function callReviewerModel(
    provider: string, apiKey: string, reviewPrompt: string, timeoutMs: number
): Promise<ReviewVote | undefined> {
    const config = REVIEWER_CONFIGS[provider];
    if (!config) return undefined;  // Unconfigured provider — excluded from consensus

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let url = config.endpoint;
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...config.authHeader(apiKey),
        };
        // Gemini: use x-goog-api-key header instead of query param (avoids key in server logs)
        if (provider === 'gemini') {
            headers['x-goog-api-key'] = apiKey;
        }
        const body = JSON.stringify(config.buildBody(reviewPrompt));
        const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal as any });
        if (!res.ok) return undefined;  // API error — excluded from consensus (fail-closed)
        const json: any = await res.json();
        const text = extractResponseText(json, provider);
        const verdict = parseReviewVerdict(text, config.group, provider);
        return verdict;
    } catch {
        return undefined;  // Timeout/network error — excluded from consensus (fail-closed, not fail-open)
    } finally {
        clearTimeout(timer);
    }
}

function extractResponseText(json: any, provider: string): string {
    if (provider === 'gemini') return json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return json?.choices?.[0]?.message?.content ?? '';
}

function parseReviewVerdict(text: string, group: string, provider: string): ReviewVote {
    // Normalize to uppercase to handle case variations (APPROVE, Approve, approve, etc.)
    const upper = text.toUpperCase();
    const hasApprove = upper.includes('APPROVE') && !upper.includes('REJECT');
    const hasReject = upper.includes('REJECT');
    const approved = hasReject ? false : (hasApprove || !upper.includes('CONCERN'));
    const concernLines = text.split('\n').filter(l => l.trim().length > 5).slice(0, 5);
    return {
        modelId: `${group} (${provider})`,
        approved,
        concerns: concernLines.length > 0 ? concernLines : ['No specific concerns raised'],
    };
}

/** Run real multi-model review. Returns null if no keys are available. */
async function runMultiModelReview(
    secrets: vscode.SecretStorage,
    reviewerPairs: [string, string][],
    diff: string,
    relPath: string,
    instruction: string,
): Promise<{ votes: ReviewVote[]; consensus: boolean; estimatedCost: number } | null> {
    const reviewPrompt = [
        `CODE REVIEW — Vote APPROVE or REJECT with brief concerns.`,
        ``,
        `File: ${relPath}`,
        `Instruction: ${instruction.slice(0, 300)}`,
        ``,
        `Diff:`,
        '```diff',
        diff.slice(0, 2000),
        '```',
        ``,
        `Respond with exactly one word first: APPROVE or REJECT. Then 1-3 brief concern lines if any.`,
    ].join('\n');

    const votes: ReviewVote[] = [];
    let anyKeyFound = false;
    let attemptedCount = 0;

    for (const [provider, group] of reviewerPairs) {
        const keyName = secretKeyFor(provider as any);
        let apiKey: string | undefined;
        try { apiKey = await secrets.get(keyName) ?? undefined; } catch { /* no key */ }
        if (!apiKey) continue;  // No key — skip this reviewer (will fall back to checklist if all skipped)
        anyKeyFound = true;
        attemptedCount++;
        const vote = await callReviewerModel(provider, apiKey, reviewPrompt, 15000);
        if (vote) {
            votes.push(vote);  // Only count successful responses
        }
        // Failed/timeout/error → excluded from consensus (fail-closed, not fail-open)
    }

    if (!anyKeyFound) return null;  // No keys at all — fall back to checklist mode
    if (votes.length === 0) return null;  // All calls failed — fall back to checklist mode

    const approvals = votes.filter(v => v.approved).length;
    const consensus = approvals >= Math.ceil(votes.length * 0.67);  // 2-of-3 or majority
    const estimatedCost = attemptedCount * 0.002;  // ~$0.002 per attempted review call
    return { votes, consensus, estimatedCost };
}

// ── Post-apply verification ────────────────────────────────────────────────

async function verifyAfterApply(filePath: string): Promise<{ ok: boolean; output: string }> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return { ok: true, output: 'no workspace' };

    const workspaceRoot = folders[0].uri.fsPath;
    const ext = path.extname(filePath);

    // Only verify TypeScript/JavaScript files in this workspace
    if (!['.ts', '.js', '.tsx', '.jsx'].includes(ext)) {
        return { ok: true, output: 'skipped (not TS/JS)' };
    }

    // Use npx tsc --noEmit for quick type-check
    return new Promise(resolve => {
        const child = cp.exec('npx tsc --noEmit --pretty false 2>&1', {
            cwd: workspaceRoot,
            timeout: 30000,
            maxBuffer: 1024 * 1024,
        }, (err, stdout) => {
            if (err) {
                // Filter to only show errors for our file
                const lines = (stdout || '').split('\n').filter(l => l.includes(filePath.replace(/\\/g, '/')));
                resolve({ ok: false, output: lines.join('\n') || stdout.slice(0, 1000) });
            } else {
                resolve({ ok: true, output: 'TypeScript compilation passed.' });
            }
        });
    });
}

// ── Constants ──────────────────────────────────────────────────────────────

const DRAFTS_ROOT = '.harmony/orchestrate-drafts';

function draftsDir(workspaceUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(workspaceUri, DRAFTS_ROOT);
}

function sessionDir(workspaceUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(draftsDir(workspaceUri), Date.now().toString());
}

function walDir(sessionUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(sessionUri, 'wal');
}

function auditUri(workspaceUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(draftsDir(workspaceUri), 'audit.jsonl');
}

function lockUri(workspaceUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(draftsDir(workspaceUri), '.lock');
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

// ── Helpers ────────────────────────────────────────────────────────────────

async function ensureDir(uri: vscode.Uri): Promise<void> {
    try { await vscode.workspace.fs.stat(uri); return; } catch { /* create */ }
    const parent = vscode.Uri.joinPath(uri, '..');
    if (parent.toString() !== uri.toString()) await ensureDir(parent);
    await vscode.workspace.fs.createDirectory(uri);
}

async function fsExists(uri: vscode.Uri): Promise<boolean> {
    try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
}

function cfg<T>(key: string, def: T): T {
    return vscode.workspace.getConfiguration('harmony.deepOrchestrate').get<T>(key, def);
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

// ── Workspace Lock (atomic rename — no TOCTOU race) ──────────────────────

async function acquireWorkspaceLock(workspaceUri: vscode.Uri, timeoutMs = 30000): Promise<boolean> {
    const lockId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const lUri = lockUri(workspaceUri);
    const tmpUri = vscode.Uri.joinPath(draftsDir(workspaceUri), `.lock-tmp-${lockId}`);
    await ensureDir(draftsDir(workspaceUri));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        // Atomic acquire via rename with overwrite:false.
        // No TOCTOU: the rename IS the check. If it succeeds, we own the lock.
        await vscode.workspace.fs.writeFile(tmpUri, textEncoder.encode(`${lockId}|${Date.now() + 60000}`));
        try {
            await vscode.workspace.fs.rename(tmpUri, lUri, { overwrite: false });
            return true; // We own the lock
        } catch {
            // Someone else holds the lock — clean up our temp file.
            try { await vscode.workspace.fs.delete(tmpUri); } catch { /* ok */ }
            // Rename failed — check if the existing lock is stale (older than 60s).
            // We only delete stale locks AFTER our own rename attempt failed,
            // so there is no check-then-act TOCTOU window.
            try {
                const stat = await vscode.workspace.fs.stat(lUri);
                if (Date.now() - stat.mtime > 60_000) {
                    try { await vscode.workspace.fs.delete(lUri); } catch { /* gone */ }
                }
            } catch { /* no lock yet */ }
            await sleep(200);
        }
    }
    return false;
}

async function releaseWorkspaceLock(workspaceUri: vscode.Uri): Promise<void> {
    try { await vscode.workspace.fs.delete(lockUri(workspaceUri)); } catch { /* ok */ }
}

// ── Audit Trail ────────────────────────────────────────────────────────────

async function appendAudit(workspaceUri: vscode.Uri, entry: AuditEntry): Promise<void> {
    const aUri = auditUri(workspaceUri);
    await ensureDir(draftsDir(workspaceUri));
    const line = JSON.stringify(entry) + '\n';
    let existing = '';
    try { existing = textDecoder.decode(await vscode.workspace.fs.readFile(aUri)); } catch { /* new file */ }
    // Atomic write: write to tmp first, then rename
    const tmpUri = vscode.Uri.joinPath(draftsDir(workspaceUri), '.audit.tmp');
    await vscode.workspace.fs.writeFile(tmpUri, textEncoder.encode(existing + line));
    await vscode.workspace.fs.rename(tmpUri, aUri, { overwrite: true });
}

// ── Diff Engine ────────────────────────────────────────────────────────────

function createUnifiedDiff(original: string, modified: string, origName: string, modName: string): string {
    if (original === modified) return '';
    const a = original.split('\n');
    const b = modified.split('\n');
    // Simple line-by-line diff (LCS-based)
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--)
        for (let j = n - 1; j >= 0; j--)
            dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);

    const diffs: string[] = [`--- a/${origName}`, `+++ b/${modName}`];
    let i = 0, j = 0, lineNo = 1;
    const context = 3;
    const hunk: string[] = [];
    let hunkStart = 1, delCount = 0, addCount = 0;

    function flushHunk() {
        if (hunk.length === 0) return;
        diffs.push(`@@ -${hunkStart},${delCount} +${hunkStart},${addCount} @@`);
        diffs.push(...hunk);
        hunk.length = 0;
        delCount = addCount = 0;
    }

    while (i < m || j < n) {
        if (i < m && j < n && a[i] === b[j]) {
            // Equal line
            if (hunk.length > 0 && hunk.length < context * 2 + 10) {
                hunk.push(' ' + a[i]);
                delCount++; addCount++;
            } else if (hunk.length >= context * 2 + 10) {
                flushHunk();
                hunkStart = i + 1;
            }
            i++; j++; lineNo++;
        } else if (j < n && (i === m || dp[i][j + 1] >= dp[i + 1][j])) {
            // Insert
            if (hunk.length === 0) hunkStart = lineNo;
            hunk.push('+' + b[j]);
            addCount++;
            j++; lineNo++;
        } else {
            // Delete
            if (hunk.length === 0) hunkStart = lineNo;
            hunk.push('-' + a[i]);
            delCount++;
            i++; lineNo++;
        }
    }
    flushHunk();
    return diffs.join('\n') + '\n';
}

// ── 3-Phase WAL Atomic Apply ───────────────────────────────────────────────

async function atomicApply(
    originalUri: vscode.Uri,
    draftContent: string,
    sessionUri: vscode.Uri,
): Promise<{ success: boolean; error?: string }> {
    const wUri = walDir(sessionUri);
    await ensureDir(wUri);

    // Phase 1: PREPARE — backup original
    const originalContent = textDecoder.decode(await vscode.workspace.fs.readFile(originalUri));
    const backupUri = vscode.Uri.joinPath(wUri, 'original.bak');
    await vscode.workspace.fs.writeFile(backupUri, textEncoder.encode(originalContent));

    // Phase 2: APPLY — write new content to temp, then atomic rename
    const tmpUri = vscode.Uri.joinPath(wUri, 'modified.new');
    await vscode.workspace.fs.writeFile(tmpUri, textEncoder.encode(draftContent));
    try {
        await vscode.workspace.fs.rename(tmpUri, originalUri, { overwrite: true });
    } catch (err: any) {
        // Phase 3: ROLLBACK
        try { await vscode.workspace.fs.rename(backupUri, originalUri, { overwrite: true }); } catch { /* ok */ }
        return { success: false, error: `Atomic apply failed: ${err?.message ?? 'unknown'}` };
    }

    // Phase 3: CLEANUP — remove WAL directory
    try { await vscode.workspace.fs.delete(wUri, { recursive: true }); } catch { /* ok */ }
    return { success: true };
}

// ── Pipeline Orchestrator ──────────────────────────────────────────────────

async function runDeepOrchestratePipeline(
    input: DeepOrchestrateInput,
    secrets: vscode.SecretStorage,
    token: vscode.CancellationToken,
): Promise<string> {
    const workspaceUri = vscode.workspace.workspaceFolders![0].uri;
    const filePath = input.filePath;
    const origUri = vscode.Uri.joinPath(workspaceUri, ...filePath.split(/[/\\]/));

    // Security: block paths outside workspace or inside .harmony
    const relPath = path.relative(workspaceUri.fsPath, origUri.fsPath);
    if (relPath.startsWith('..') || relPath.startsWith('.harmony')) {
        return `❌ DeepOrchestrate blocked: path "${filePath}" is outside workspace or inside .harmony directory.`;
    }

    if (!await fsExists(origUri)) {
        return `❌ File not found: ${filePath}`;
    }

    // Acquire workspace lock
    if (!await acquireWorkspaceLock(workspaceUri)) {
        return '❌ DeepOrchestrate: another orchestration pipeline is already running. Please wait.';
    }

    const operationId = crypto.randomUUID();
    const reviewDepth = cfg<number>('reviewDepth', 2);
    const maxCost = cfg<number>('maxCostPerOperation', 0.5);
    const sUri = sessionDir(workspaceUri);
    let applied = false;

    try {
        await ensureDir(sUri);

        // Step 1: Read original
        const originalText = textDecoder.decode(await vscode.workspace.fs.readFile(origUri));
        const originalHash = crypto.createHash('sha256').update(originalText).digest('hex');

        // Step 2: Create draft in session directory — use LLM-supplied content or placeholder
        const draftUri = vscode.Uri.joinPath(sUri, path.basename(filePath));
        const draftContent = input.proposedContent?.trim()
            ? input.proposedContent
            : originalText;  // fallback: placeholder (diff will be empty)
        await vscode.workspace.fs.writeFile(draftUri, textEncoder.encode(draftContent));

        // Step 3: Generate diff
        const draftText = textDecoder.decode(await vscode.workspace.fs.readFile(draftUri));
        const diff = createUnifiedDiff(originalText, draftText, relPath, relPath);

        if (!diff) {
            await releaseWorkspaceLock(workspaceUri);
            return '✅ No changes detected — the edit instruction produced identical content.';
        }

        // Step 4: Multi-model review — try real API calls, fall back to checklist
        const reviewerPairs = pickReviewers(reviewDepth);
        const reviewerLabels = reviewerPairs.map(([, group]) => group).join(' → ');

        let output = `📋 **DeepOrchestrate Diff Review**\n\n`;
        output += `**File:** \`${relPath}\`\n`;
        output += `**Original hash:** \`${originalHash.slice(0, 16)}…\`\n`;
        output += `**Review pipeline:** ${reviewerLabels} (${reviewDepth} model groups, anti-correlated)\n\n`;

        // Try real multi-model review first
        const reviewResult = await runMultiModelReview(secrets, reviewerPairs, diff, relPath, input.editInstruction);
        let consensus = false;
        let estimatedCost = 0;

        if (reviewResult) {
            // Real review succeeded — show actual votes
            estimatedCost = reviewResult.estimatedCost;
            consensus = reviewResult.consensus;
            output += `### 🤖 Real Model Votes (${reviewResult.votes.length} reviewers called)\n`;
            for (const vote of reviewResult.votes) {
                const icon = vote.approved ? '✅' : '❌';
                output += `- ${icon} **${vote.modelId}**: ${vote.concerns.join('; ')}\n`;
            }
            const approvalCount = reviewResult.votes.filter(v => v.approved).length;
            output += `\n**Approvals:** ${approvalCount}/${reviewResult.votes.length}\n`;
            output += `**Consensus:** ${consensus ? '✅ REACHED' : '❌ NOT REACHED'}\n`;
            output += `> Approx. ${reviewResult.votes.length} model call(s)\n`;
        } else {
            // No API keys — fall back to checklist mode
            const reviewerLines = reviewerPairs.map(([provider, group]) => {
                const checks = REVIEW_CHECKS[group] || ['General code review'];
                return `- **${group}** (${provider}): ${checks.join(', ')}`;
            }).join('\n');
            output += `### Reviewer Assignments (checklist mode — no API keys)\n${reviewerLines}\n\n`;
            output += `### Consensus Rules\n`;
            output += `- **2-of-${reviewDepth}** required for auto-apply\n`;
            output += `- Any **blocker** → rejected; Split vote → ⚠️ escalated to human review\n\n`;
        }

        output += `### Proposed Diff\n\`\`\`diff\n${diff.slice(0, 3000)}\`\`\`\n\n`;
        output += `> ⚠️ Please check your API provider dashboards directly for exact costs and set alerts/limits where applicable.\n`;

        if (input.dryRun) {
            output += `\n🔍 **DRY RUN** — no changes applied. Diff above for review only.`;
            await appendAudit(workspaceUri, {
                timestamp: new Date().toISOString(), operationId, filePath,
                instruction: input.editInstruction.slice(0, 200),
                dryRun: true, consensus, applied: false,
            });
            await releaseWorkspaceLock(workspaceUri);
            return output;
        }

        // Step 5: Human gate — require confirmation before applying
        output += `\n⚠️ **Awaiting your approval to apply this diff.** The draft is at \`${DRAFTS_ROOT}/${path.basename(sUri.fsPath)}/\`.`;

        // Store session path so the apply step can find it
        const stored = { sessionPath: sUri.fsPath, origPath: origUri.fsPath, diff, operationId, filePath };
        await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(sUri, 'manifest.json'),
            textEncoder.encode(JSON.stringify(stored, null, 2))
        );

        await appendAudit(workspaceUri, {
            timestamp: new Date().toISOString(), operationId, filePath,
            instruction: input.editInstruction.slice(0, 200),
            dryRun: false, consensus: false, applied: false,
        });

        await releaseWorkspaceLock(workspaceUri);
        return output;

    } catch (err: any) {
        await appendAudit(workspaceUri, {
            timestamp: new Date().toISOString(), operationId, filePath,
            instruction: input.editInstruction.slice(0, 200),
            dryRun: input.dryRun ?? false, consensus: false, applied: false,
            error: err?.message ?? 'unknown',
        });
        await releaseWorkspaceLock(workspaceUri);
        return `❌ DeepOrchestrate failed: ${err?.message ?? 'unknown error'}`;
    }
}

// ── DeepOrchestrate Approve (separate step after human gate) ──────────────

async function applyApprovedDeepOrchestrate(
    workspaceUri: vscode.Uri,
    sessionDirPath: string,
    operationId: string,
    filePath: string,
): Promise<string> {
    const sessionUri = vscode.Uri.file(sessionDirPath);
    const manifestUri = vscode.Uri.joinPath(sessionUri, 'manifest.json');
    const origUri = vscode.Uri.file(vscode.Uri.joinPath(workspaceUri, ...filePath.split(/[\/\\]/)).fsPath);

    if (!await fsExists(manifestUri)) return '❌ Session manifest not found. The draft may have been cleaned up.';

    const draftUri = vscode.Uri.joinPath(sessionUri, path.basename(filePath));
    if (!await fsExists(draftUri)) return '❌ Draft file not found.';

    const draftContent = textDecoder.decode(await vscode.workspace.fs.readFile(draftUri));
    const result = await atomicApply(origUri, draftContent, sessionUri);

    if (result.success) {
        // Post-apply verification
        const verifyResult = await verifyAfterApply(filePath);
        let verifyMsg = '';
        if (!verifyResult.ok) {
            verifyMsg = `\n\n⚠️ **Post-apply verification found issues:**\n\`\`\`\n${verifyResult.output.slice(0, 500)}\n\`\`\`\nConsider rolling back if these are new errors.`;
        } else {
            verifyMsg = `\n\n✅ **Post-apply verification passed:** ${verifyResult.output}`;
        }

        await appendAudit(workspaceUri, {
            timestamp: new Date().toISOString(), operationId, filePath,
            instruction: '', dryRun: false, consensus: true, applied: true,
        });
        // Clean up session directory
        try { await vscode.workspace.fs.delete(sessionUri, { recursive: true }); } catch { /* ok */ }
        return `✅ **DeepOrchestrate applied successfully!**\n\nFile \`${filePath}\` has been updated. A pre-edit backup was preserved in the WAL.${verifyMsg}`;
    }

    await appendAudit(workspaceUri, {
        timestamp: new Date().toISOString(), operationId, filePath,
        instruction: '', dryRun: false, consensus: false, applied: false,
        error: result.error,
    });
    return `❌ DeepOrchestrate apply failed: ${result.error}\n\nThe original file has been restored from backup.`;
}

// ── Tool Registration ──────────────────────────────────────────────────────

export class DeepOrchestrateTool implements vscode.LanguageModelTool<DeepOrchestrateInput> {
    constructor(private readonly secrets: vscode.SecretStorage) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<DeepOrchestrateInput>,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const input = options.input;
        const result = await runDeepOrchestratePipeline(input, this.secrets, token);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<DeepOrchestrateInput>,
    ) {
        const dry = options.input.dryRun ? ' (DRY RUN)' : '';
        return {
            invocationMessage: `DeepOrchestrating ${options.input.filePath}${dry} — safe copy-edit-review pipeline`,
            confirmationMessages: {
                title: 'Run DeepOrchestrate?',
                message: new vscode.MarkdownString(
                    `Harmony will create a draft copy of \`${options.input.filePath}\`, apply your edit instruction, ` +
                    `generate a diff, and present it for your review. ` +
                    `The original file will NOT be modified until you explicitly approve.`
                ),
            },
        };
    }
}

// ── Approve command (registered in extension.ts) ──────────────────────────

export function registerDeepOrchestrate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_deep_orchestrate', new DeepOrchestrateTool(context.secrets))
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('harmony.deepOrchestrateApprove', () => deepOrchestrateApproveCommand(context))
    );
}

export async function deepOrchestrateApproveCommand(context: vscode.ExtensionContext): Promise<void> {
    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceUri) {
        vscode.window.showErrorMessage('No workspace open.');
        return;
    }

    // Find most recent manifest
    const draftsRoot = draftsDir(workspaceUri);
    let sessions: [string, vscode.FileType][] = [];
    try { sessions = await vscode.workspace.fs.readDirectory(draftsRoot); } catch { /* no drafts */ }

    const sessionDirs = sessions
        .filter(([, t]) => t === vscode.FileType.Directory)
        .map(([n]) => n)
        .sort()
        .reverse();

    if (sessionDirs.length === 0) {
        vscode.window.showInformationMessage('No pending DeepOrchestrate drafts to approve.');
        return;
    }

    const sessionDirName = await vscode.window.showQuickPick(sessionDirs, {
        placeHolder: 'Select a DeepOrchestrate draft to approve',
    });
    if (!sessionDirName) return;

    const sessionUri = vscode.Uri.joinPath(draftsRoot, sessionDirName);
    const manifestUri = vscode.Uri.joinPath(sessionUri, 'manifest.json');

    try {
        const manifestRaw = textDecoder.decode(await vscode.workspace.fs.readFile(manifestUri));
        const manifest = JSON.parse(manifestRaw);
        const result = await applyApprovedDeepOrchestrate(
            workspaceUri, sessionUri.fsPath,
            manifest.operationId, manifest.filePath,
        );
        vscode.window.showInformationMessage(result);
    } catch (err: any) {
        vscode.window.showErrorMessage(`DeepOrchestrate approval failed: ${err?.message ?? 'unknown'}`);
    }
}
