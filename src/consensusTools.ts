/**
 * Consensus Protocol — VS Code-facing tool (`harmony_consensus_round`).
 *
 * Runs a declarative, hash-bound multi-model deliberation. Dual-transport by design:
 *  - seats marked `provider` are dispatched automatically (via the existing routing);
 *  - seats marked `manual` return the exact prompt for a human to carry to a model
 *    Harmony cannot reach directly (and can `ingest` the answer back).
 *
 * The mechanism is generic; the seats, providers and tiers come from a protocol file
 * the caller points at.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { consult, type ProviderId, type Tier } from './providers';
import { clipResult } from './toolResultCap';
import {
    type ConsensusProtocol, type ConsensusLedger, type DisagreementKind, type SeatPosition,
    defaultProtocol, normalizeProtocol, validateProtocol, hashArtifacts, combinedArtifactHash,
    ledgerId, newLedger, renderRound1Prompt, renderPeerPrompt, positionsForRound,
    computeVerdict, isStale, newDisagreement, classifyDisagreement, readJson, writeJson,
} from './consensus';

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(clipResult(text))]);
}

interface ConsensusInput {
    action: 'template' | 'plan' | 'dispatch' | 'ingest' | 'report' | 'status';
    protocol?: string;
    ledger_id?: string;
    round?: number;
    seat?: string;
    answer?: string;
    model?: string;
    kind?: DisagreementKind;
    /** report-only: record an explicit agreement, or a disagreement to classify. */
    agreement?: string;
    disagreement?: { topic: string; seats?: string[]; kind?: DisagreementKind; evidence?: string };
    note?: string;
}

function workspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error('No workspace folder is open.');
    return folder.uri.fsPath;
}

function cfg<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('harmony').get<T>(key) ?? fallback;
}

function protocolPath(input?: string): string {
    const root = workspaceRoot();
    const rel = input || cfg('consensus.protocolPath', '.harmony/protocols/consensus-round.json');
    return path.isAbsolute(rel) ? rel : path.join(root, rel);
}

function ledgerDir(): string {
    const root = workspaceRoot();
    const rel = cfg('consensus.ledgerDir', '.harmony/consensus');
    return path.isAbsolute(rel) ? rel : path.join(root, rel);
}

function latestLedgerFile(): string | undefined {
    const dir = ledgerDir();
    if (!fs.existsSync(dir)) return undefined;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
        .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
    return files.length ? path.join(dir, files[0].f) : undefined;
}

function resolveLedgerPath(id?: string): string | undefined {
    if (id) {
        const p = path.join(ledgerDir(), `${id}.json`);
        return fs.existsSync(p) ? p : undefined;
    }
    return latestLedgerFile();
}

class ConsensusRoundTool implements vscode.LanguageModelTool<ConsensusInput> {
    constructor(private readonly secrets: vscode.SecretStorage) {}

    async invoke(options: vscode.LanguageModelToolInvocationOptions<ConsensusInput>, token: vscode.CancellationToken) {
        const { action } = options.input;
        try {
            switch (action) {
                case 'template': return this.template();
                case 'plan': return await this.plan(options.input);
                case 'dispatch': return await this.dispatch(options.input, token);
                case 'ingest': return this.ingest(options.input);
                case 'report': return this.report(options.input);
                case 'status': return this.status(options.input);
                default: return textResult(`error: unknown action "${action}". Use template|plan|dispatch|ingest|report|status.`);
            }
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ConsensusInput>) {
        const a = options.input.action;
        return { invocationMessage: a === 'dispatch'
            ? 'Running a consensus round (dispatching provider seats)'
            : `Consensus protocol: ${a}` };
    }

    // ── actions ────────────────────────────────────────────────────────────

    private template(): vscode.LanguageModelToolResult {
        const t = defaultProtocol('<name>', '<the exact question the panel must answer>');
        return textResult([
            'Generic protocol template — write this to your protocol file (default .harmony/protocols/consensus-round.json).',
            'The seats, providers and tiers come from your protocol file, not from the extension.',
            '',
            '```json',
            JSON.stringify(t, null, 2),
            '```',
            '',
            'Seat transport: "provider" (auto-dispatched via {provider, tier}) or "manual" (you carry the prompt).',
        ].join('\n'));
    }

    private async plan(input: ConsensusInput): Promise<vscode.LanguageModelToolResult> {
        const pPath = protocolPath(input.protocol);
        if (!fs.existsSync(pPath)) {
            return textResult([
                `No protocol file at ${pPath}.`,
                '',
                'Run this tool with action:"template" to get a generic starting point, then add your seats locally.',
            ].join('\n'));
        }
        const raw = readJson<any>(pPath);
        const problems = validateProtocol(raw);
        if (problems.length) return textResult(`Protocol invalid:\n- ${problems.join('\n- ')}`);
        const protocol = normalizeProtocol(raw);

        const root = workspaceRoot();
        const artifacts = hashArtifacts(protocol.artifacts, root);
        const id = ledgerId(protocol.name);
        const ledger = newLedger(protocol, id, artifacts);
        const ledgerPath = path.join(ledgerDir(), `${id}.json`);
        writeJson(ledgerPath, ledger);

        const lines = [
            `# Consensus plan — ${protocol.name}`,
            `ledger: ${id}`,
            `rounds: ${ledger.rounds} · convergence: ${ledger.convergence} · dissent: ${ledger.dissentPolicy}`,
            `artifacts bound (${artifacts.length}) — verdict auto-invalidates if any change:`,
            ...artifacts.map(a => `  · ${a.path} = ${a.sha256.slice(0, 12)}…`),
            `combined: ${combinedArtifactHash(artifacts).slice(0, 16)}…`,
            '',
            '## Round 1 — independent prompts',
        ];
        const providerSeats = protocol.panel.filter(s => s.transport === 'provider');
        const manualSeats = protocol.panel.filter(s => s.transport === 'manual');
        lines.push(`provider seats (auto): ${providerSeats.map(s => s.id).join(', ') || '—'}`);
        lines.push(`manual seats (carry the prompt): ${manualSeats.map(s => s.id).join(', ') || '—'}`);
        lines.push('');
        for (const seat of manualSeats) {
            lines.push(`### ${seat.id} — prompt to paste into your model`);
            lines.push('```');
            lines.push(renderRound1Prompt(protocol, seat));
            lines.push('```');
            lines.push('');
        }
        if (providerSeats.length) {
            lines.push(`Next: action:"dispatch" (round 1) to auto-fill ${providerSeats.map(s => s.id).join(', ')}.`);
        }
        lines.push('For manual seats, run action:"ingest" with {seat, answer} once you have their reply.');
        return textResult(lines.join('\n'));
    }

    private async dispatch(input: ConsensusInput, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
        const lPath = resolveLedgerPath(input.ledger_id);
        if (!lPath) return textResult('No ledger found. Run action:"plan" first.');
        const ledger = readJson<ConsensusLedger>(lPath)!;
        const pPath = protocolPath(input.protocol);
        const protocol = normalizeProtocol(readJson<any>(pPath) ?? {});
        const round = input.round ?? 1;
        const cap = protocol.maxProviderCallsPerRound ?? cfg('consensus.maxProviderCallsPerRound', 6);

        const providerSeats = protocol.panel.filter(s => s.transport === 'provider');
        const peerAnswers = round > 1
            ? positionsForRound(ledger, round - 1).filter(p => p.answer).map(p => ({ seat: p.seat, answer: p.answer! }))
            : [];

        const done = new Set(positionsForRound(ledger, round).map(p => p.seat));
        const out: string[] = [`# Dispatch — round ${round} (${ledger.id})`];
        let calls = 0;

        for (const seat of providerSeats) {
            if (done.has(seat.id)) { out.push(`- ${seat.id}: already recorded`); continue; }
            if (calls >= cap) { out.push(`- ${seat.id}: SKIPPED (per-round provider-call cap ${cap})`); continue; }
            calls++;
            const prompt = round > 1 ? renderPeerPrompt(protocol, seat, round, peerAnswers) : renderRound1Prompt(protocol, seat);
            try {
                const r = await consult(this.secrets, {
                    provider: seat.provider as ProviderId,
                    tier: (seat.tier as Tier) ?? 'mid',
                    question: prompt,
                }, token);
                const pos: SeatPosition = {
                    seat: seat.id, round, transport: 'provider',
                    answer: r.text, model: `${r.provider}/${r.model}`,
                    recordedAt: new Date().toISOString(),
                };
                ledger.positions.push(pos);
                out.push(`- ${seat.id} (${r.provider}/${r.model}): recorded ${r.text.length} chars`);
            } catch (e: any) {
                out.push(`- ${seat.id}: PROVIDER ERROR — ${e?.message ?? String(e)}`);
            }
        }

        ledger.snapshots.push({ at: new Date().toISOString(), artifactsHash: combinedArtifactHash(ledger.artifacts), note: `round ${round} dispatch` });
        ledger.verdict = computeVerdict(ledger);
        writeJson(lPath, ledger);

        const manualSeats = protocol.panel.filter(s => s.transport === 'manual');
        if (manualSeats.length) {
            out.push('', '## Manual seats — paste one of these prompts into your model');
            for (const seat of manualSeats) {
                if (done.has(seat.id)) continue;
                out.push(`### ${seat.id}`);
                out.push('```');
                out.push(round > 1 ? renderPeerPrompt(protocol, seat, round, peerAnswers) : renderRound1Prompt(protocol, seat));
                out.push('```');
            }
            out.push('Return each reply with action:"ingest" {seat, answer}.');
        }
        return textResult(out.join('\n'));
    }

    private ingest(input: ConsensusInput): vscode.LanguageModelToolResult {
        const lPath = resolveLedgerPath(input.ledger_id);
        if (!lPath) return textResult('No ledger found. Run action:"plan" first.');
        if (!input.seat || !input.answer?.trim()) return textResult('error: ingest needs {seat, answer}');
        const ledger = readJson<ConsensusLedger>(lPath)!;
        const round = input.round ?? 1;
        ledger.positions.push({
            seat: input.seat, round, transport: 'manual',
            answer: input.answer, model: input.model,
            recordedAt: new Date().toISOString(),
        });
        if (input.note) ledger.notes.push(`[${input.seat}] ${input.note}`);
        ledger.verdict = computeVerdict(ledger);
        writeJson(lPath, ledger);
        const have = positionsForRound(ledger, round).map(p => p.seat).join(', ');
        return textResult(`Recorded ${input.seat} (round ${round}). Round ${round} now has: ${have}`);
    }

    private report(input: ConsensusInput): vscode.LanguageModelToolResult {
        const lPath = resolveLedgerPath(input.ledger_id);
        if (!lPath) return textResult('No ledger found. Run action:"plan" first.');
        const ledger = readJson<ConsensusLedger>(lPath)!;
        const root = workspaceRoot();

        if (input.agreement) ledger.agreements.push(input.agreement);
        if (input.disagreement?.topic) {
            const seats = input.disagreement.seats ?? [];
            const kind = classifyDisagreement(`${input.disagreement.topic} ${input.disagreement.evidence ?? ''}`, input.disagreement.kind);
            ledger.disagreements.push(newDisagreement(input.disagreement.topic, seats, kind, input.disagreement.evidence));
        }
        ledger.verdict = computeVerdict(ledger);
        const stale = isStale(ledger, root);
        writeJson(lPath, ledger);

        const byRound = new Map<number, SeatPosition[]>();
        for (const p of ledger.positions) {
            if (!byRound.has(p.round)) byRound.set(p.round, []);
            byRound.get(p.round)!.push(p);
        }
        const lines = [
            `# Consensus report — ${ledger.protocol} (${ledger.id})`,
            `verdict: ${ledger.verdict.toUpperCase()}  ·  convergence: ${ledger.convergence}  ·  dissent: ${ledger.dissentPolicy}`,
            stale.stale
                ? `⚠️ STALE — bound artifact(s) changed since this verdict: ${stale.changed.join(', ')}. Recheck required.`
                : 'artifacts unchanged — verdict is current for the bound hashes.',
            '',
            `## Positions (${ledger.positions.length})`,
            ...[...byRound.entries()].sort((a, b) => a[0] - b[0]).map(([r, ps]) =>
                `round ${r}: ${ps.map(p => `${p.seat}${p.model ? ` (${p.model})` : ''}`).join(', ')}`),
            '',
            `## Agreements (${ledger.agreements.length})`,
            ...(ledger.agreements.length ? ledger.agreements.map(a => `- ${a}`) : ['- (none recorded)']),
            '',
            `## Disagreements (${ledger.disagreements.length})`,
            ...(ledger.disagreements.length
                ? ledger.disagreements.map(d => `- [${d.kind}] ${d.topic}${d.resolution ? ` — resolved: ${d.resolution}` : ' — UNRESOLVED'} (${d.seats.join(', ') || 'panel'})`)
                : ['- (none recorded)']),
            '',
            ledger.verdict === 'disagreed'
                ? 'Unresolved disagreement is a RESULT, not a failure — record it, name its kind, and keep both positions.'
                : ledger.verdict === 'converged'
                    ? 'Converged: agreement recorded with no unresolved disagreement.'
                    : 'Incomplete: no agreement or disagreement recorded yet.',
        ];
        return textResult(lines.join('\n'));
    }

    private status(input: ConsensusInput): vscode.LanguageModelToolResult {
        const lPath = resolveLedgerPath(input.ledger_id);
        if (!lPath) return textResult('No ledger found yet.');
        const ledger = readJson<ConsensusLedger>(lPath)!;
        const stale = isStale(ledger, workspaceRoot());
        return textResult([
            `ledger: ${ledger.id}`,
            `protocol: ${ledger.protocol}  ·  verdict: ${ledger.verdict}`,
            `positions: ${ledger.positions.length}  ·  agreements: ${ledger.agreements.length}  ·  disagreements: ${ledger.disagreements.length}`,
            stale.stale ? `STALE (changed: ${stale.changed.join(', ')})` : 'current',
        ].join('\n'));
    }
}

export function registerConsensusTools(context: vscode.ExtensionContext) {
    vscode.lm.registerTool('harmony_consensus_round', new ConsensusRoundTool(context.secrets));
}
