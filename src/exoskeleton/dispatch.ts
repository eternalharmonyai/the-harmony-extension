/**
 * exoskeleton/dispatch.ts — Specialist Dispatch with return contracts.
 *
 * Every specialist gets a narrow mandate and a hard output shape.
 * A specialist that returns more than its contract allows has failed,
 * regardless of content quality.
 *
 * Return contract (v2):
 * ≤300 tokens | file:line | finding | confidence (H/M/L)
 * | src: trusted|untrusted
 * | coverage: searched[] | skipped[] + reason
 *
 * Validator-lite: 5 mechanical checks on every return.
 * Conflict adjudication: when two returns conflict on the same key.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { MAX_TOOL_RETURN_TOKENS, DISPATCH_DIR } from './constants';
import { estimateTokens } from './utils';

// ── Return Contract Types ────────────────────────────────────────────

export type Confidence = 'H' | 'M' | 'L';
export type Provenance = 'trusted' | 'untrusted';

export interface DispatchFinding {
    file?: string;
    line?: number;
    finding: string;
    confidence: Confidence;
    provenance: Provenance;
    coverage: {
        searched: string[];
        skipped: string[];
        skipReason?: string;
    };
}

export interface DispatchReturn {
    specialistId: string;
    taskId: string;
    findings: DispatchFinding[];
    rawReturn: string;
    tokenEstimate: number;
    violations: ContractViolation[];
}

export interface ContractViolation {
    type: 'SIZE' | 'SHAPE' | 'PROVENANCE' | 'COVERAGE' | 'H_LEGALITY';
    message: string;
}

// ── Validator-Lite ───────────────────────────────────────────────────

/**
 * Validate a specialist return against the 5 mechanical checks.
 */
export function validateReturn(rawReturn: string, specialistId: string, taskId: string): DispatchReturn {
    const violations: ContractViolation[] = [];
    const tokens = estimateTokens(rawReturn);

    // 1. SIZE: chars/4 ≤ 300
    if (tokens > MAX_TOOL_RETURN_TOKENS) {
        violations.push({
            type: 'SIZE',
            message: `Return exceeds ${MAX_TOOL_RETURN_TOKENS} tokens (est. ${tokens}). Specialist is relaying, not compressing.`,
        });
    }

    // 2-5: parse findings and check each
    const findings = parseFindings(rawReturn);
    for (const f of findings) {
        // 2. SHAPE: file:line | finding | confidence
        if (!f.finding || !f.confidence) {
            violations.push({
                type: 'SHAPE',
                message: 'Finding missing required field (finding text or confidence).',
            });
        }

        // 3. PROVENANCE: src: present
        if (!f.provenance) {
            violations.push({
                type: 'PROVENANCE',
                message: 'Finding missing provenance flag (src:trusted|untrusted). Defaulting to untrusted.',
            });
            f.provenance = 'untrusted';
        }

        // 4. COVERAGE: searched[] | skipped[] present
        if (!f.coverage || (f.coverage.searched.length === 0 && f.coverage.skipped.length === 0)) {
            violations.push({
                type: 'COVERAGE',
                message: 'Finding missing coverage declaration. Absence claims are void.',
            });
        }

        // 5. H-LEGALITY: conf: H only alongside oracle-verified or direct-read evidence
        if (f.confidence === 'H' && f.provenance === 'untrusted') {
            violations.push({
                type: 'H_LEGALITY',
                message: 'High confidence on untrusted source is a contradiction. Downgraded to M.',
            });
            f.confidence = 'M';
        }
    }

    return {
        specialistId,
        taskId,
        findings,
        rawReturn,
        tokenEstimate: tokens,
        violations,
    };
}

/**
 * Parse raw specialist return into structured findings.
 * Expected format: lines of "file:line | finding | conf | src:prov | coverage: ..."
 */
function parseFindings(raw: string): DispatchFinding[] {
    const findings: DispatchFinding[] = [];
    const lines = raw.split('\n').filter(l => l.trim());

    for (const line of lines) {
        // Try to parse structured format
        const fileMatch = line.match(/([\w./-]+):(\d+)/);
        const confMatch = line.match(/conf(?:idence)?:?\s*(H|M|L)/i);
        const srcMatch = line.match(/src:?\s*(trusted|untrusted)/i);
        const coverageMatch = line.match(/coverage:?\s*searched\[([^\]]*)\]\s*\|?\s*skipped\[([^\]]*)\]/i);

        // Extract finding text (everything between | separators or the line itself)
        const parts = line.split('|').map(p => p.trim());
        const findingText = parts.length >= 2 ? parts[1] : line;

        findings.push({
            file: fileMatch?.[1],
            line: fileMatch?.[2] ? parseInt(fileMatch[2]) : undefined,
            finding: findingText,
            confidence: (confMatch?.[1]?.toUpperCase() as Confidence) ?? 'M',
            provenance: (srcMatch?.[1] as Provenance) ?? 'untrusted',
            coverage: {
                searched: coverageMatch?.[1] ? coverageMatch[1].split(',').map(s => s.trim()).filter(Boolean) : [],
                skipped: coverageMatch?.[2] ? coverageMatch[2].split(',').map(s => s.trim()).filter(Boolean) : [],
                skipReason: undefined,
            },
        });
    }

    return findings;
}

// ── Full Report Storage ──────────────────────────────────────────────

/**
 * Write a full dispatch report to .harmony/dispatches/<id>.md.
 * The compact contract returns to the pilot; the full report persists.
 */
export function saveFullReport(return_: DispatchReturn): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const dir = path.join(root, DISPATCH_DIR);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const id = crypto.createHash('sha256')
        .update(`${return_.specialistId}-${return_.taskId}-${Date.now()}`)
        .digest('hex')
        .slice(0, 8);
    const reportPath = path.join(dir, `${id}.md`);

    const lines: string[] = [
        `# Dispatch Report: ${return_.specialistId}`,
        ``,
        `**Task:** ${return_.taskId}`,
        `**Timestamp:** ${new Date().toISOString()}`,
        `**Token Estimate:** ${return_.tokenEstimate}`,
        `**Violations:** ${return_.violations.length}`,
        ``,
    ];

    if (return_.violations.length > 0) {
        lines.push('## Contract Violations');
        for (const v of return_.violations) {
            lines.push(`- [${v.type}] ${v.message}`);
        }
        lines.push('');
    }

    lines.push('## Findings');
    for (const f of return_.findings) {
        const loc = f.file ? `${f.file}:${f.line ?? '?'}` : '(no location)';
        lines.push(`- ${loc} | ${f.finding} | conf: ${f.confidence} | src: ${f.provenance}`);
        if (f.coverage.searched.length > 0 || f.coverage.skipped.length > 0) {
            lines.push(`  - coverage: searched[${f.coverage.searched.join(', ')}] | skipped[${f.coverage.skipped.join(', ')}]`);
        }
    }
    lines.push('');
    lines.push('## Raw Return');
    lines.push('```');
    lines.push(return_.rawReturn);
    lines.push('```');

    fs.writeFileSync(reportPath, lines.join('\n'), 'utf-8');
    return reportPath;
}

// ── Conflict Adjudication ────────────────────────────────────────────

export type AdjudicationVerdict = 'A' | 'B' | 'both-partial' | 'insufficient-evidence';

export interface ConflictRecord {
    claimKey: string;
    findingA: DispatchFinding;
    findingB: DispatchFinding;
    verdict?: AdjudicationVerdict;
    settlingCommand?: string;
}

/**
 * Detect conflicting findings on the same claim key (file:line + topic).
 */
export function detectConflicts(returns: DispatchReturn[]): ConflictRecord[] {
    const conflicts: ConflictRecord[] = [];
    const claimMap = new Map<string, DispatchFinding[]>();

    for (const ret of returns) {
        for (const f of ret.findings) {
            const key = f.file && f.line ? `${f.file}:${f.line}` : f.finding.slice(0, 50);
            if (!claimMap.has(key)) claimMap.set(key, []);
            claimMap.get(key)!.push(f);
        }
    }

    for (const [key, findings] of claimMap) {
        if (findings.length >= 2) {
            // Check if findings actually conflict (different confidence or contradictory text)
            const distinct = new Set(findings.map(f => `${f.confidence}:${f.finding.slice(0, 30)}`));
            if (distinct.size > 1) {
                conflicts.push({
                    claimKey: key,
                    findingA: findings[0],
                    findingB: findings[1],
                });
            }
        }
    }

    return conflicts;
}
