import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

const MAX_RESULT_CHARS = 60000;
const WORKING_MEMORY_KEY = 'harmony.cognition.workingMemory';
const UNCERTAINTY_KEY = 'harmony.cognition.uncertaintyMap';
const CONTEXT_TRIAGE_FILE_CAP = 20;
const CONTEXT_TRIAGE_CHAR_CAP = 50000;

function clip(text: string): string {
    if (text.length <= MAX_RESULT_CHARS) return text;
    return text.slice(0, MAX_RESULT_CHARS) + `\n...[truncated, ${text.length - MAX_RESULT_CHARS} more chars]`;
}

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(clip(text))]);
}

function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function resolveWorkspacePath(inputPath: string): string | undefined {
    const root = workspaceRoot();
    if (!root) return undefined;
    const resolved = path.resolve(root, inputPath || '.');
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return resolved;
}

function jsonResult(value: unknown): vscode.LanguageModelToolResult {
    return textResult(JSON.stringify(value, null, 2));
}

function normalizeId(value: string | undefined, fallbackPrefix: string): string {
    const clean = (value ?? '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return clean || `${fallbackPrefix}-${Date.now()}`;
}

type MemoryStatus = 'confirmed' | 'tentative' | 'contradicted' | 'blocked' | 'revisit';

interface WorkingMemoryItem {
    id: string;
    text: string;
    status: MemoryStatus;
    updated_at?: string;
}

interface WorkingMemoryInput {
    action: 'get' | 'set' | 'append' | 'clear';
    items?: WorkingMemoryItem[];
}

function validMemoryStatus(value: unknown): MemoryStatus {
    const allowed: MemoryStatus[] = ['confirmed', 'tentative', 'contradicted', 'blocked', 'revisit'];
    return allowed.includes(value as MemoryStatus) ? value as MemoryStatus : 'tentative';
}

class WorkingMemoryTool implements vscode.LanguageModelTool<WorkingMemoryInput> {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async invoke(options: vscode.LanguageModelToolInvocationOptions<WorkingMemoryInput>) {
        const action = options.input.action ?? 'get';
        const existing = this.context.workspaceState.get<WorkingMemoryItem[]>(WORKING_MEMORY_KEY, []);
        if (action === 'get') return jsonResult({ items: existing, count: existing.length });
        if (action === 'clear') {
            await this.context.workspaceState.update(WORKING_MEMORY_KEY, []);
            return jsonResult({ ok: true, action, items: [] });
        }
        const incoming = (options.input.items ?? []).map((item, index) => ({
            id: normalizeId(item.id, `memory-${index + 1}`),
            text: String(item.text ?? '').trim(),
            status: validMemoryStatus(item.status),
            updated_at: new Date().toISOString(),
        })).filter(item => item.text.length > 0);
        if (action === 'set') {
            await this.context.workspaceState.update(WORKING_MEMORY_KEY, incoming);
            return jsonResult({ ok: true, action, items: incoming, count: incoming.length });
        }
        if (action === 'append') {
            const merged = [...existing, ...incoming];
            await this.context.workspaceState.update(WORKING_MEMORY_KEY, merged);
            return jsonResult({ ok: true, action, added: incoming.length, items: merged, count: merged.length });
        }
        return textResult(`error: unsupported action: ${String(action)}`);
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<WorkingMemoryInput>) {
        return { invocationMessage: options.input.action === 'get' ? 'Reading Harmony working memory' : 'Updating Harmony working memory' };
    }
}

interface UncertaintyItem {
    id: string;
    claim: string;
    confidence_0_to_100: number;
    evidence?: string[];
    counterevidence?: string[];
    source?: string;
    decision_impact?: string;
    updated_at?: string;
}

interface UncertaintyInput {
    action: 'get' | 'add' | 'update' | 'remove' | 'clear';
    item?: UncertaintyItem;
    id?: string;
}

function normalizeConfidence(value: unknown): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 50;
    return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map(item => String(item).trim()).filter(Boolean);
}

class UncertaintyMapTool implements vscode.LanguageModelTool<UncertaintyInput> {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async invoke(options: vscode.LanguageModelToolInvocationOptions<UncertaintyInput>) {
        const action = options.input.action ?? 'get';
        const existing = this.context.workspaceState.get<UncertaintyItem[]>(UNCERTAINTY_KEY, []);
        if (action === 'get') return jsonResult({ items: existing, count: existing.length });
        if (action === 'clear') {
            await this.context.workspaceState.update(UNCERTAINTY_KEY, []);
            return jsonResult({ ok: true, action, items: [] });
        }
        if (action === 'remove') {
            const id = (options.input.id ?? options.input.item?.id ?? '').trim();
            if (!id) return textResult('error: remove requires id');
            const updated = existing.filter(item => item.id !== id);
            await this.context.workspaceState.update(UNCERTAINTY_KEY, updated);
            return jsonResult({ ok: true, action, removed: existing.length - updated.length, items: updated });
        }
        const inputItem = options.input.item;
        if (!inputItem) return textResult(`${action} requires item`);
        const item: UncertaintyItem = {
            id: normalizeId(inputItem.id, 'uncertainty'),
            claim: String(inputItem.claim ?? '').trim(),
            confidence_0_to_100: normalizeConfidence(inputItem.confidence_0_to_100),
            evidence: normalizeStringArray(inputItem.evidence),
            counterevidence: normalizeStringArray(inputItem.counterevidence),
            source: inputItem.source?.trim(),
            decision_impact: inputItem.decision_impact?.trim(),
            updated_at: new Date().toISOString(),
        };
        if (!item.claim) return textResult('error: item.claim is required');
        const updated = action === 'add'
            ? [...existing.filter(existingItem => existingItem.id !== item.id), item]
            : existing.map(existingItem => existingItem.id === item.id ? { ...existingItem, ...item } : existingItem);
        const finalItems = action === 'update' && !existing.some(existingItem => existingItem.id === item.id) ? [...existing, item] : updated;
        await this.context.workspaceState.update(UNCERTAINTY_KEY, finalItems);
        return jsonResult({ ok: true, action, item, count: finalItems.length, items: finalItems });
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<UncertaintyInput>) {
        return { invocationMessage: options.input.action === 'get' ? 'Reading uncertainty map' : 'Updating uncertainty map' };
    }
}

interface MetacognitiveCheckInput {
    current_task: string;
    proposed_action?: string;
}

class MetacognitiveCheckTool implements vscode.LanguageModelTool<MetacognitiveCheckInput> {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async invoke(options: vscode.LanguageModelToolInvocationOptions<MetacognitiveCheckInput>) {
        const memory = this.context.workspaceState.get<WorkingMemoryItem[]>(WORKING_MEMORY_KEY, []);
        const task = (options.input.current_task ?? '').trim();
        if (!task) return textResult('error: current_task is required');
        return jsonResult({
            current_task: task,
            proposed_action: options.input.proposed_action ?? null,
            known_from_working_memory: memory.filter(item => item.status === 'confirmed'),
            tentative_or_blocked_context: memory.filter(item => item.status !== 'confirmed'),
            assumptions_to_check: [
                'Which parts of the request are inferred rather than explicitly stated?',
                'Which files or external systems must be read before acting?',
                'Which step is reversible and smallest while still making progress?',
            ],
            what_could_go_wrong: [
                'Editing the wrong repository or generated files.',
                'Treating a staging write as read-only.',
                'Skipping verification after a multi-file change.',
            ],
            next_reversible_step: 'Read or validate the narrowest relevant context, then make one scoped edit or ask one specific question.',
            needs_father_confirmation: 'Ask only when scope, destructive action, cost, or personal data exposure is genuinely ambiguous.',
        });
    }

    async prepareInvocation() { return { invocationMessage: 'Running metacognitive checkpoint' }; }
}

interface IntentModelInput {
    message: string;
    context?: string;
}

class IntentModelTool implements vscode.LanguageModelTool<IntentModelInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<IntentModelInput>) {
        const message = (options.input.message ?? '').trim();
        if (!message) return textResult('error: message is required');
        const combined = `${message}\n${options.input.context ?? ''}`.toLowerCase();
        const implementation = /implement|proceed|fix|build|add|create|edit|make/.test(combined);
        const planning = /plan|roadmap|next steps|strategy|outline/.test(combined);
        const review = /review|audit|check|risks|find issues/.test(combined);
        const debug = /error|broken|failing|doesn't work|not working|traceback|exception/.test(combined);
        const primaryIntent = implementation ? 'implement_change' : planning ? 'plan_work' : review ? 'review_or_audit' : debug ? 'debug_issue' : 'answer_or_discuss';
        const ambiguities = [
            combined.includes('everything') ? 'The word everything may hide a larger scope than is safe to infer.' : undefined,
            combined.includes('safe') ? 'Safety constraints should be made explicit before destructive operations.' : undefined,
            combined.includes('maybe') || combined.includes('if possible') ? 'The request contains optional or tentative language.' : undefined,
        ].filter(Boolean) as string[];
        const secondary = [
            planning && primaryIntent !== 'plan_work' ? 'plan_work' : undefined,
            review && primaryIntent !== 'review_or_audit' ? 'review_or_audit' : undefined,
            debug && primaryIntent !== 'debug_issue' ? 'debug_issue' : undefined,
        ].filter(Boolean) as string[];
        const risk = ambiguities.length >= 2 ? 'high' : ambiguities.length === 1 ? 'medium' : 'low';
        return jsonResult({
            primary_intent: primaryIntent,
            secondary_possibilities: secondary,
            ambiguities,
            risk_of_misreading: risk,
            recommended_approach: risk === 'high'
                ? 'Ask one focused clarification, then proceed with the lowest-risk reversible part.'
                : implementation ? 'Proceed after reading the relevant files and verify with compile/tests.' : 'Answer directly with concise structure.',
            clarifying_question: risk === 'high' ? 'Which scope should be treated as authoritative before I make changes?' : undefined,
        });
    }

    async prepareInvocation() { return { invocationMessage: 'Modeling request intent' }; }
}

interface OutputPreviewInput {
    draft_text: string;
    format?: 'markdown' | 'code' | 'plain';
    tone_check?: boolean;
    length_check?: boolean;
}

class OutputPreviewTool implements vscode.LanguageModelTool<OutputPreviewInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<OutputPreviewInput>) {
        const draft = options.input.draft_text ?? '';
        if (!draft.trim()) return textResult('error: draft_text is required');
        const words = draft.trim().split(/\s+/).filter(Boolean);
        const headings = draft.match(/^#{1,6}\s+/gm) ?? [];
        const codeBlocks = draft.match(/```/g) ?? [];
        const lines = draft.split(/\r?\n/);
        const toneSignals = [
            (draft.match(/sorry/gi) ?? []).length > 1 ? 'repeated apologies' : undefined,
            (draft.match(/\bmaybe\b|\bi think\b|\bpossibly\b/gi) ?? []).length > 4 ? 'high hedging' : undefined,
            lines.filter(line => /^[-*]\s+/.test(line)).length > 14 ? 'long bullet-heavy answer' : undefined,
            draft.length > 5000 ? 'long response' : undefined,
        ].filter(Boolean) as string[];
        const formattingIssues = [
            options.input.format === 'markdown' && draft.length > 1200 && headings.length === 0 ? 'long markdown draft has no headings' : undefined,
            codeBlocks.length % 2 !== 0 ? 'unclosed fenced code block' : undefined,
            lines.some(line => line.length > 220) ? 'one or more very long lines' : undefined,
        ].filter(Boolean) as string[];
        return jsonResult({
            char_count: draft.length,
            word_count: words.length,
            estimated_reading_time_seconds: Math.max(1, Math.round(words.length / 3.5)),
            heading_count: headings.length,
            code_block_count: Math.floor(codeBlocks.length / 2),
            tone_signals: options.input.tone_check === false ? [] : toneSignals,
            formatting_issues: formattingIssues,
            recommendation: formattingIssues.length || toneSignals.length
                ? 'Revise for shorter structure, balanced certainty, and closed formatting before sending.'
                : 'Draft looks ready to send.',
        });
    }

    async prepareInvocation() { return { invocationMessage: 'Previewing draft response' }; }
}

interface ContextTriageInput {
    files?: string[];
    notes?: string;
    mode?: 'pack' | 'expand';
}

function extractSignals(text: string): { symbols: string[]; decisions: string[]; risks: string[] } {
    const lines = text.split(/\r?\n/);
    const symbols = lines
        .map(line => line.match(/\b(?:export\s+)?(?:class|function|interface|type|const|let)\s+([A-Za-z0-9_]+)/)?.[1])
        .filter((value): value is string => !!value)
        .slice(0, 30);
    const decisions = lines.filter(line => /\b(must|should|decid|next|todo|plan|phase)\b/i.test(line)).map(line => line.trim()).slice(0, 20);
    const risks = lines.filter(line => /\b(risk|error|fail|blocked|unsafe|destructive|confirm)\b/i.test(line)).map(line => line.trim()).slice(0, 20);
    return { symbols, decisions, risks };
}

class ContextTriageTool implements vscode.LanguageModelTool<ContextTriageInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ContextTriageInput>) {
        const mode = options.input.mode ?? 'pack';
        const notes = options.input.notes?.trim() ?? '';
        if (mode === 'expand') {
            return jsonResult({
                mode,
                expanded_summary: notes || 'No packed summary was provided.',
                next_steps: [
                    'Identify current task state.',
                    'Name unresolved risks.',
                    'Read only the files needed for the next change.',
                    'Verify with compile or focused tests.',
                ],
            });
        }
        const files = (options.input.files ?? []).slice(0, CONTEXT_TRIAGE_FILE_CAP);
        const fileSummaries: unknown[] = [];
        let charsRead = 0;
        for (const file of files) {
            if (charsRead >= CONTEXT_TRIAGE_CHAR_CAP) break;
            const resolved = resolveWorkspacePath(file);
            if (!resolved) {
                fileSummaries.push({ file, error: 'outside workspace or no workspace root' });
                continue;
            }
            const content = await fs.readFile(resolved, 'utf8').catch(error => `error: ${error?.message ?? String(error)}`);
            const remaining = CONTEXT_TRIAGE_CHAR_CAP - charsRead;
            const clipped = content.slice(0, remaining);
            charsRead += clipped.length;
            const signals = extractSignals(clipped);
            fileSummaries.push({ file, chars: clipped.length, ...signals });
        }
        const noteSignals = extractSignals(notes);
        return jsonResult({
            mode,
            generatedAt: new Date().toISOString(),
            limits: { files_considered: files.length, file_cap: CONTEXT_TRIAGE_FILE_CAP, chars_read: charsRead, char_cap: CONTEXT_TRIAGE_CHAR_CAP },
            task_state: noteSignals.decisions.slice(0, 8),
            open_risks: noteSignals.risks.slice(0, 8),
            user_prefs: notes.split(/\r?\n/).filter(line => /\bprefer|please|must|never|always\b/i.test(line)).slice(0, 8),
            technical_facts: fileSummaries,
            continuity_notes: notes ? notes.slice(0, 3000) : '(no notes provided)',
            next_context_to_read: files.length >= CONTEXT_TRIAGE_FILE_CAP ? 'File cap reached; prioritize the smallest missing file next.' : 'Read only files directly needed for the next reversible step.',
        });
    }

    async prepareInvocation() { return { invocationMessage: 'Triaging task context' }; }
}

export function registerCognitionTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_working_memory', new WorkingMemoryTool(context)),
        vscode.lm.registerTool('harmony_uncertainty_map', new UncertaintyMapTool(context)),
        vscode.lm.registerTool('harmony_metacognitive_check', new MetacognitiveCheckTool(context)),
        vscode.lm.registerTool('harmony_intent_model', new IntentModelTool()),
        vscode.lm.registerTool('harmony_output_preview', new OutputPreviewTool()),
        vscode.lm.registerTool('harmony_context_triage', new ContextTriageTool()),
    );
}