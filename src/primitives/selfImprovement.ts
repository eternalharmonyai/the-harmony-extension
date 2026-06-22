/**
 * Self-Improvement Loop — Beyond-100% Phase B2
 *
 * Autonomous pattern detection and knowledge generation.
 * Watches for repeated anti-patterns across sessions, maintains a pattern database,
 * and auto-proposes Conductor knowledge modules when thresholds are met.
 *
 * Architecture:
 *   Session → Pattern Detector → Anti-Pattern DB → Threshold Trigger → Knowledge Proposal
 *                                                         │
 *                                             3+ occurrences of same issue
 *                                                         ↓
 *                                       Auto-write .harmony/conductor/knowledge/learned-*.md
 *                                       Auto-index in HarmonyHub
 *                                       Require human confirmation for finalization
 *
 * Pattern Categories:
 *   - context_truncation: file too large for worker context
 *   - continuity_mismatch: claimed state doesn't match actual files
 *   - duplicate_work: same fix applied multiple times
 *   - tool_registration: tools registered but not in manifest
 *   - dependency_conflict: package version conflicts
 *   - worker_timeout: worker exceeding time limits
 *   - snapshot_conflict: file too large for snapshot
 *   - compilation_loop: repeated compile-fix-compile cycles
 *   - missing_validation: skipping test/compile after changes
 *   - path_casing: wrong case in file paths
 *
 * @example
 *   invoke({ action: 'fingerprint', session_summary: 'Fixed 3 context truncation bugs' });
 *   invoke({ action: 'detect', session_id: 'sess-123' });
 *   invoke({ action: 'proposals' }); // List pending knowledge proposals
 *   invoke({ action: 'accept', proposal_id: 'prop-abc' }); // Accept and write
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { workspaceRoot, textResult, ensureDir, uid } from './shared';
import { safeHarmonyDir, readJsonl, appendJsonl } from '../swarmHarden';
import { BasePrimitive } from './basePrimitive';

// ─── Types ───────────────────────────────────────────────────────────

interface SessionFingerprint {
    session_id: string;
    timestamp: number;
    patterns_detected: string[];
    error_types: string[];
    tool_failures: string[];
    truncation_events: number;
    compile_cycles: number;
    files_modified: number;
    workers_dispatched: number;
    summary: string;
}

interface AntiPatternRecord {
    pattern_id: string;
    category: string;
    description: string;
    occurrences: number;
    first_seen: number;
    last_seen: number;
    session_ids: string[];
    severity: 'low' | 'medium' | 'high';
    auto_threshold: number; // occurrences needed for auto-proposal
    status: 'active' | 'proposed' | 'accepted' | 'rejected';
}

interface KnowledgeProposal {
    proposal_id: string;
    pattern_id: string;
    title: string;
    content: string; // markdown content for the knowledge module
    confidence: number; // 0-1 based on occurrence frequency
    created: number;
    status: 'pending' | 'accepted' | 'rejected';
    target_path: string; // where to write the knowledge file
}

interface SelfImprovementInput {
    action: 'fingerprint' | 'detect' | 'proposals' | 'accept' | 'reject' | 'stats' | 'patterns';
    session_summary?: string;
    session_id?: string;
    proposal_id?: string;
    force?: boolean; // skip confirmation for accept
}

// ─── Pattern Categories & Defaults ─────────────────────────────────

const PATTERN_DEFAULTS: Omit<AntiPatternRecord, 'pattern_id' | 'occurrences' | 'first_seen' | 'last_seen' | 'session_ids' | 'status'>[] = [
    {
        category: 'context_truncation',
        description: 'File content exceeded worker context limit, causing truncated analysis',
        severity: 'high',
        auto_threshold: 3,
    },
    {
        category: 'continuity_mismatch',
        description: 'Continuity ledger claimed state that didn\'t match actual file contents',
        severity: 'high',
        auto_threshold: 3,
    },
    {
        category: 'duplicate_work',
        description: 'Same fix or feature was implemented multiple times across sessions',
        severity: 'medium',
        auto_threshold: 3,
    },
    {
        category: 'tool_registration',
        description: 'Tools registered in code but missing from package.json manifest',
        severity: 'medium',
        auto_threshold: 2,
    },
    {
        category: 'dependency_conflict',
        description: 'Package version conflicts causing install or compile failures',
        severity: 'high',
        auto_threshold: 2,
    },
    {
        category: 'worker_timeout',
        description: 'Worker process exceeded time limit without producing results',
        severity: 'medium',
        auto_threshold: 3,
    },
    {
        category: 'snapshot_conflict',
        description: 'File exceeded snapshot size limit, blocking safe edits',
        severity: 'medium',
        auto_threshold: 2,
    },
    {
        category: 'compilation_loop',
        description: 'Repeated compile-fix-compile cycles indicating unclear error messages',
        severity: 'low',
        auto_threshold: 5,
    },
    {
        category: 'missing_validation',
        description: 'Changes committed without running compile or tests first',
        severity: 'high',
        auto_threshold: 2,
    },
    {
        category: 'path_casing',
        description: 'Wrong case in file paths causing cross-platform issues',
        severity: 'medium',
        auto_threshold: 3,
    },
];

// ─── Knowledge Proposal Templates ──────────────────────────────────

const PROPOSAL_TEMPLATES: Record<string, (title: string, occurrences: number) => string> = {
    context_truncation: (title, n) => `# ${title}

## Category
Context Truncation Prevention

## Pattern Detected
Files sent to workers were truncated because they exceeded the worker's context limit. This happened **${n} times** across multiple sessions.

## Why This Matters
When a worker receives a truncated file, it produces incomplete analysis. This leads to:
- False confidence in incomplete results
- Wasted turns re-dispatching
- Missed bugs in the unseen portion of the file

## Recommended Practice
1. **Chunk files >12KB** before dispatching to workers
2. **Use \`max_chars_per_file\`** parameter to control context size
3. **Pre-verify file sizes** with \`harmony_read_file\` before dispatch
4. **Monitor worker output** for truncation markers

## Auto-detected by Harmony Self-Improvement Loop
This knowledge module was auto-generated on ${new Date().toISOString().split('T')[0]}.
Threshold: ${n} occurrences triggered automatic proposal.
`,
    continuity_mismatch: (title, n) => `# ${title}

## Category
Continuity Integrity

## Pattern Detected
The continuity ledger claimed a certain state (e.g., "all fixes applied") that did not match the actual files on disk. This happened **${n} times** across multiple sessions.

## Why This Matters
Continuity mismatches cause:
- Wasted time re-verifying already-completed work
- False assumptions about what's done vs. pending
- Cascading errors when decisions are based on incorrect state

## Recommended Practice
1. **Always verify continuity claims** against actual files before acting
2. **Use \`harmony_read_file\`** to spot-check claimed fixes
3. **Prefer \`harmony_grep\`** to verify patterns exist in source
4. **Update continuity ledger only after verification**, not before

## Auto-detected by Harmony Self-Improvement Loop
This knowledge module was auto-generated on ${new Date().toISOString().split('T')[0]}.
Threshold: ${n} occurrences triggered automatic proposal.
`,
    duplicate_work: (title, n) => `# ${title}

## Category
Duplicate Work Prevention

## Pattern Detected
The same fix or feature was implemented **${n} times** across different sessions, suggesting the first implementation wasn't properly verified or documented.

## Why This Matters
Duplicate work wastes:
- Session time re-implementing solved problems
- Cognitive load tracking what was already done
- Trust in the continuity system

## Recommended Practice
1. **Check continuity ledger** before starting any fix
2. **Verify fixes exist** with \`harmony_grep\` before re-implementing
3. **Document completed work** in Conductor Journal
4. **Commit and push** after each completed fix to prevent drift

## Auto-detected by Harmony Self-Improvement Loop
This knowledge module was auto-generated on ${new Date().toISOString().split('T')[0]}.
Threshold: ${n} occurrences triggered automatic proposal.
`,
    tool_registration: (title, n) => `# ${title}

## Category
Tool Registration Hygiene

## Pattern Detected
Tools were registered in source code but not declared in \`package.json\` manifest. This happened **${n} times**.

## Why This Matters
Unregistered tools:
- Are invisible to the AI model (can't be called)
- Cause self-diagnose warnings
- Create confusion about available capabilities

## Recommended Practice
1. **Always add manifest entry** when registering a new tool
2. **Add activation event** \`onLanguageModelTool:tool_name\`
3. **Run \`harmony_self_diagnose\`** after adding tools to verify
4. **Remove dead entries** when tools are deprecated

## Auto-detected by Harmony Self-Improvement Loop
This knowledge module was auto-generated on ${new Date().toISOString().split('T')[0]}.
Threshold: ${n} occurrences triggered automatic proposal.
`,
};

const DEFAULT_TEMPLATE = (title: string, n: number, category: string) => `# ${title}

## Category
${category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}

## Pattern Detected
This anti-pattern was observed **${n} times** across multiple sessions.

## Recommended Practice
1. **Be aware** of this pattern when it appears
2. **Document** workarounds in Conductor Journal
3. **Consider** if tooling or process changes could prevent recurrence

## Auto-detected by Harmony Self-Improvement Loop
This knowledge module was auto-generated on ${new Date().toISOString().split('T')[0]}.
Threshold: ${n} occurrences triggered automatic proposal.
`;

// ─── Self-Improvement Engine ────────────────────────────────────────

export class SelfImprovementTool extends BasePrimitive<SelfImprovementInput> {
    constructor() { super('self-improvement'); }

    private patternsPath(root: string): string {
        const dir = safeHarmonyDir(root, 'self-improvement');
        return path.join(dir, 'patterns.jsonl');
    }

    private proposalsPath(root: string): string {
        const dir = safeHarmonyDir(root, 'self-improvement');
        return path.join(dir, 'proposals.jsonl');
    }

    private knowledgeDir(root: string): string {
        return path.join(root, '.harmony', 'conductor', 'knowledge');
    }

    private async ensureDirs(root: string): Promise<void> {
        const dir = safeHarmonyDir(root, 'self-improvement');
        await ensureDir(dir);
        await ensureDir(this.knowledgeDir(root));
    }

    private async loadPatterns(root: string): Promise<AntiPatternRecord[]> {
        try {
            return await readJsonl<AntiPatternRecord>(this.patternsPath(root));
        } catch {
            return [];
        }
    }

    private async savePatterns(root: string, patterns: AntiPatternRecord[]): Promise<void> {
        await this.ensureDirs(root);
        // Rewrite entire file (patterns are small)
        const pp = this.patternsPath(root);
        const lines = patterns.map(p => JSON.stringify(p)).join('\n') + '\n';
        await fs.writeFile(pp, lines, 'utf8');
    }

    private async loadProposals(root: string): Promise<KnowledgeProposal[]> {
        try {
            return await readJsonl<KnowledgeProposal>(this.proposalsPath(root));
        } catch {
            return [];
        }
    }

    protected async invokeImpl(
        options: vscode.LanguageModelToolInvocationOptions<SelfImprovementInput>,
        _token: vscode.CancellationToken
    ) {
        const fieldErr = this.requireFields(options.input as any, ['action']);
        if (fieldErr) return textResult(JSON.stringify({ error: fieldErr }));

        const { action, session_summary, session_id, proposal_id, force = false } = options.input;
        const root = workspaceRoot();
        if (!root) return textResult(JSON.stringify({ error: 'no workspace' }));

        await this.ensureDirs(root);

        switch (action) {
            case 'fingerprint': {
                // Analyze current session and detect patterns
                if (!session_summary?.trim()) {
                    return textResult(JSON.stringify({ error: 'session_summary required for fingerprinting' }));
                }

                const sessId = session_id ?? uid();
                const summary = session_summary.trim().toLowerCase();

                // Detect patterns from session summary text
                const detected: string[] = [];
                const patternMap: Record<string, string[]> = {
                    context_truncation: ['truncat', 'chunk', '12kb', 'context limit', 'file too large'],
                    continuity_mismatch: ['continuity', 'ledger', 'mismatch', "didn't match", 'stale'],
                    duplicate_work: ['duplicate', 'already implemented', 'already done', 're-implement'],
                    tool_registration: ['manifest', 'registration mismatch', 'not in manifest', 'not registered'],
                    dependency_conflict: ['dependency', 'version conflict', 'install fail', 'npm error'],
                    worker_timeout: ['timeout', 'worker', 'exceeded time', 'too long'],
                    snapshot_conflict: ['snapshot', 'too large', 'exceeds', '262144'],
                    compilation_loop: ['compile', 'fix', 'compile again', 'compile loop'],
                    missing_validation: ['no test', 'no compile', 'skipped validation', 'without testing'],
                    path_casing: ['wrong case', 'path casing', 'case sensitive', 'case mismatch'],
                };

                for (const [category, keywords] of Object.entries(patternMap)) {
                    if (keywords.some(kw => summary.includes(kw))) {
                        detected.push(category);
                    }
                }

                // Load existing patterns and update
                const patterns = await this.loadPatterns(root);
                const now = Date.now();
                let newProposals = 0;

                for (const category of detected) {
                    let pattern = patterns.find(p => p.category === category);
                    if (!pattern) {
                        // Create new pattern
                        const defaults = PATTERN_DEFAULTS.find(d => d.category === category);
                        pattern = {
                            pattern_id: uid(),
                            category,
                            description: defaults?.description ?? `Auto-detected: ${category}`,
                            occurrences: 0,
                            first_seen: now,
                            last_seen: now,
                            session_ids: [],
                            severity: defaults?.severity ?? 'medium',
                            auto_threshold: defaults?.auto_threshold ?? 3,
                            status: 'active',
                        };
                        patterns.push(pattern);
                    }

                    pattern.occurrences++;
                    pattern.last_seen = now;
                    if (!pattern.session_ids.includes(sessId)) {
                        pattern.session_ids.push(sessId);
                    }

                    // Check threshold for auto-proposal
                    if (pattern.occurrences >= pattern.auto_threshold && pattern.status === 'active') {
                        pattern.status = 'proposed';
                        const proposals = await this.loadProposals(root);
                        const proposalTitle = this.generateTitle(pattern.category, pattern.occurrences);
                        const templateFn = PROPOSAL_TEMPLATES[pattern.category] ?? DEFAULT_TEMPLATE;
                        const content = templateFn(proposalTitle, pattern.occurrences);
                        const propFileName = `learned-${pattern.category.replace(/_/g, '-')}.md`;

                        const proposal: KnowledgeProposal = {
                            proposal_id: uid(),
                            pattern_id: pattern.pattern_id,
                            title: proposalTitle,
                            content,
                            confidence: Math.min(pattern.occurrences / pattern.auto_threshold, 1.0),
                            created: now,
                            status: 'pending',
                            target_path: path.join(this.knowledgeDir(root), propFileName),
                        };

                        await appendJsonl(this.proposalsPath(root), proposal);
                        newProposals++;
                    }
                }

                await this.savePatterns(root, patterns);

                const fingerprint: SessionFingerprint = {
                    session_id: sessId,
                    timestamp: now,
                    patterns_detected: detected,
                    error_types: [],
                    tool_failures: [],
                    truncation_events: detected.filter(d => d === 'context_truncation').length,
                    compile_cycles: detected.filter(d => d === 'compilation_loop').length,
                    files_modified: 0,
                    workers_dispatched: 0,
                    summary: session_summary,
                };

                return textResult(JSON.stringify({
                    fingerprint,
                    patterns_updated: detected.length,
                    new_proposals: newProposals,
                    total_patterns: patterns.length,
                    active_patterns: patterns.filter(p => p.status === 'active').length,
                }, null, 2));
            }

            case 'detect': {
                // Detect patterns without creating a session fingerprint
                const patterns = await this.loadPatterns(root);
                const active = patterns.filter(p => p.status === 'active');
                const proposed = patterns.filter(p => p.status === 'proposed');
                const accepted = patterns.filter(p => p.status === 'accepted');

                return textResult(JSON.stringify({
                    total: patterns.length,
                    active: active.length,
                    proposed: proposed.length,
                    accepted: accepted.length,
                    nearing_threshold: active
                        .filter(p => p.occurrences >= p.auto_threshold - 1)
                        .map(p => ({ category: p.category, occurrences: p.occurrences, threshold: p.auto_threshold })),
                    patterns: patterns.map(p => ({
                        category: p.category,
                        occurrences: p.occurrences,
                        severity: p.severity,
                        threshold: p.auto_threshold,
                        status: p.status,
                        progress: `${p.occurrences}/${p.auto_threshold}`,
                    })),
                }, null, 2));
            }

            case 'proposals': {
                const proposals = await this.loadProposals(root);
                return textResult(JSON.stringify({
                    total: proposals.length,
                    pending: proposals.filter(p => p.status === 'pending').length,
                    accepted: proposals.filter(p => p.status === 'accepted').length,
                    proposals: proposals.map(p => ({
                        proposal_id: p.proposal_id,
                        title: p.title,
                        confidence: p.confidence,
                        status: p.status,
                        target_path: p.target_path,
                        created: new Date(p.created).toISOString(),
                    })),
                }, null, 2));
            }

            case 'accept': {
                if (!proposal_id) {
                    return textResult(JSON.stringify({ error: 'proposal_id required' }));
                }

                const proposals = await this.loadProposals(root);
                const propIdx = proposals.findIndex(p => p.proposal_id === proposal_id);
                if (propIdx < 0) {
                    return textResult(JSON.stringify({ error: `proposal '${proposal_id}' not found` }));
                }

                const proposal = proposals[propIdx];

                // Write knowledge module to .harmony/conductor/knowledge/
                await ensureDir(path.dirname(proposal.target_path));
                await fs.writeFile(proposal.target_path, proposal.content, 'utf8');

                // Update proposal status
                proposal.status = 'accepted';
                proposals[propIdx] = proposal;

                // Rewrite proposals file
                const pp = this.proposalsPath(root);
                const lines = proposals.map(p => JSON.stringify(p)).join('\n') + '\n';
                await fs.writeFile(pp, lines, 'utf8');

                // Update pattern status
                const patterns = await this.loadPatterns(root);
                const patIdx = patterns.findIndex(p => p.pattern_id === proposal.pattern_id);
                if (patIdx >= 0) {
                    patterns[patIdx].status = 'accepted';
                    await this.savePatterns(root, patterns);
                }

                return textResult(JSON.stringify({
                    status: 'accepted',
                    proposal_id,
                    title: proposal.title,
                    written_to: proposal.target_path,
                    confidence: proposal.confidence,
                }, null, 2));
            }

            case 'reject': {
                if (!proposal_id) {
                    return textResult(JSON.stringify({ error: 'proposal_id required' }));
                }

                const proposals = await this.loadProposals(root);
                const propIdx = proposals.findIndex(p => p.proposal_id === proposal_id);
                if (propIdx < 0) {
                    return textResult(JSON.stringify({ error: `proposal '${proposal_id}' not found` }));
                }

                proposals[propIdx].status = 'rejected';
                const pp = this.proposalsPath(root);
                const lines = proposals.map(p => JSON.stringify(p)).join('\n') + '\n';
                await fs.writeFile(pp, lines, 'utf8');

                // Reset pattern to active so it can re-propose later
                const patterns = await this.loadPatterns(root);
                const patIdx = patterns.findIndex(p => p.pattern_id === proposals[propIdx].pattern_id);
                if (patIdx >= 0) {
                    patterns[patIdx].status = 'active';
                    await this.savePatterns(root, patterns);
                }

                return textResult(JSON.stringify({ status: 'rejected', proposal_id }));
            }

            case 'stats': {
                const patterns = await this.loadPatterns(root);
                const proposals = await this.loadProposals(root);

                return textResult(JSON.stringify({
                    patterns: {
                        total: patterns.length,
                        by_severity: {
                            high: patterns.filter(p => p.severity === 'high').length,
                            medium: patterns.filter(p => p.severity === 'medium').length,
                            low: patterns.filter(p => p.severity === 'low').length,
                        },
                        by_status: {
                            active: patterns.filter(p => p.status === 'active').length,
                            proposed: patterns.filter(p => p.status === 'proposed').length,
                            accepted: patterns.filter(p => p.status === 'accepted').length,
                            rejected: patterns.filter(p => p.status === 'rejected').length,
                        },
                        top_patterns: patterns
                            .sort((a, b) => b.occurrences - a.occurrences)
                            .slice(0, 5)
                            .map(p => ({ category: p.category, occurrences: p.occurrences, severity: p.severity })),
                    },
                    proposals: {
                        total: proposals.length,
                        pending: proposals.filter(p => p.status === 'pending').length,
                        accepted: proposals.filter(p => p.status === 'accepted').length,
                    },
                    knowledge_files: (() => {
                        try {
                            const kd = this.knowledgeDir(root);
                            return fs.readdir(kd).then(files => files.filter(f => f.startsWith('learned-')).length).catch(() => 0);
                        } catch { return 0; }
                    })(),
                }, null, 2));
            }

            case 'patterns': {
                // List all known pattern categories and their descriptions
                return textResult(JSON.stringify({
                    pattern_categories: PATTERN_DEFAULTS.map(p => ({
                        category: p.category,
                        description: p.description,
                        severity: p.severity,
                        auto_threshold: p.auto_threshold,
                        has_template: p.category in PROPOSAL_TEMPLATES,
                    })),
                }, null, 2));
            }

            default:
                return textResult(JSON.stringify({ error: `unknown action: ${action}` }));
        }
    }

    private generateTitle(category: string, occurrences: number): string {
        const titles: Record<string, string> = {
            context_truncation: 'Prevent Worker Context Truncation',
            continuity_mismatch: 'Verify Continuity Claims Against Files',
            duplicate_work: 'Avoid Duplicate Work Across Sessions',
            tool_registration: 'Keep Tool Registration in Sync with Manifest',
            dependency_conflict: 'Prevent Package Dependency Conflicts',
            worker_timeout: 'Handle Worker Timeouts Gracefully',
            snapshot_conflict: 'Handle Large File Snapshots',
            compilation_loop: 'Break Compile-Fix-Compile Loops',
            missing_validation: 'Always Validate After Changes',
            path_casing: 'Use Consistent File Path Casing',
        };
        return titles[category] ?? `Auto-Detected Pattern: ${category.replace(/_/g, ' ')}`;
    }
}
