/**
 * Phase 3-7: Research upgrade tools — pdf_ingest, conflict_detector,
 * citation_influence, code_theory_bridge, research state machine.
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

const CORPUS_DIR = '.harmony/corpus';
const PROJECTS_DIR = '.harmony/research-projects';

// ── Helpers ─────────────────────────────────────────────────────────────────

function clip(text: string, max = 60000): string {
    return text.length <= max ? text : text.slice(0, max) + `\n...[${text.length - max} more chars]`;
}

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(clip(text))]);
}

function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3: PDF Ingestion
// ═══════════════════════════════════════════════════════════════════════════════

interface PdfIngestInput {
    file_path?: string;
    url?: string;
    title?: string;
}

interface CorpusEntry {
    id: string;
    source: 'file' | 'url';
    originalPath: string;
    title: string;
    text: string;
    wordCount: number;
    ingestedAt: string;
    sha256: string;
}

class PdfIngestTool implements vscode.LanguageModelTool<PdfIngestInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<PdfIngestInput>) {
        const input = options.input;
        const root = workspaceRoot();
        if (!root) return textResult('error: no workspace folder open');

        const corpusPath = path.join(root, CORPUS_DIR);
        await ensureDir(corpusPath);

        let rawText = '';
        let source: 'file' | 'url' = 'file';
        let originalPath = '';

        // From file
        if (input.file_path) {
            const resolved = path.isAbsolute(input.file_path)
                ? input.file_path
                : path.resolve(root, input.file_path);
            try {
                const pdfParse = require('pdf-parse');
                const buffer = await fs.readFile(resolved);
                const data = await pdfParse(buffer);
                rawText = data.text;
                originalPath = resolved;
                source = 'file';
            } catch (e: any) {
                return textResult(`error: could not read PDF at ${resolved}: ${e?.message ?? String(e)}`);
            }
        }

        // From URL
        if (input.url) {
            try {
                const response = await fetch(input.url, {
                    headers: { 'User-Agent': 'Harmony-Research/0.3.0' },
                    signal: AbortSignal.timeout(30000),
                });
                const buffer = Buffer.from(await response.arrayBuffer());
                const pdfParse = require('pdf-parse');
                const data = await pdfParse(buffer);
                rawText = data.text;
                originalPath = input.url;
                source = 'url';
            } catch (e: any) {
                return textResult(`error: could not fetch PDF from ${input.url}: ${e?.message ?? String(e)}`);
            }
        }

        if (!rawText.trim()) {
            return textResult('error: no text extracted — provide file_path or url to a PDF');
        }

        // Store corpus entry
        const id = `corpus-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const title = input.title || path.basename(originalPath, '.pdf') || 'Untitled';
        const entry: CorpusEntry = {
            id,
            source,
            originalPath,
            title,
            text: rawText,
            wordCount: rawText.split(/\s+/).length,
            ingestedAt: new Date().toISOString(),
            sha256: crypto.createHash('sha256').update(rawText).digest('hex'),
        };

        await fs.writeFile(
            path.join(corpusPath, `${id}.json`),
            JSON.stringify(entry, null, 2),
            'utf8'
        );

        return textResult([
            `# PDF Ingested: ${title}`,
            '',
            `| Property | Value |`,
            `|---|---|`,
            `| **ID** | \`${id}\` |`,
            `| **Source** | ${source === 'file' ? originalPath : originalPath} |`,
            `| **Words** | ${entry.wordCount.toLocaleString()} |`,
            `| **SHA256** | ${entry.sha256.slice(0, 16)}... |`,
            `| **Stored** | \`.harmony/corpus/${id}.json\` |`,
            '',
            '## First 500 chars',
            '',
            '```',
            rawText.slice(0, 500),
            '```',
            '',
            '## Next Steps',
            '- Run `harmony_qualitative_coder` on this text to extract themes',
            '- Run `harmony_evidence_matrix` with claims from this paper',
            '- Use `harmony_literature_scan` to find related papers',
        ].join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<PdfIngestInput>) {
        const label = options.input.file_path
            ? path.basename(options.input.file_path)
            : options.input.url
                ? new URL(options.input.url).hostname
                : 'PDF';
        return { invocationMessage: `Ingesting PDF: ${label}` };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 4a: Conflict Detector
// ═══════════════════════════════════════════════════════════════════════════════

interface ConflictDetectorInput {
    texts: string[];       // Corpus entry IDs or raw text blocks
    topic?: string;
}

class ConflictDetectorTool implements vscode.LanguageModelTool<ConflictDetectorInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ConflictDetectorInput>) {
        const input = options.input;
        if (!input.texts?.length) return textResult('error: provide at least one text (corpus ID or raw text)');

        const root = workspaceRoot();
        const corpusPath = root ? path.join(root, CORPUS_DIR) : null;

        // Resolve texts (could be corpus IDs or raw text)
        const resolved: { title: string; text: string }[] = [];
        for (const t of input.texts.slice(0, 10)) {
            // Try as corpus ID
            if (corpusPath && /^corpus-/.test(t)) {
                try {
                    const entry: CorpusEntry = JSON.parse(
                        await fs.readFile(path.join(corpusPath, `${t}.json`), 'utf8')
                    );
                    resolved.push({ title: entry.title, text: entry.text });
                    continue;
                } catch { /* fall through to raw text */ }
            }
            // Treat as raw text
            resolved.push({ title: `Text ${resolved.length + 1}`, text: t });
        }

        if (resolved.length < 2) {
            return textResult('error: need at least 2 texts to detect conflicts');
        }

        // Simple conflict detection: find claims that differ across texts
        const topic = input.topic || 'the topic';
        const wordSets = resolved.map(r => new Set(tokenize(r.text)));

        // Find words present in some texts but not others = potential conflicts
        const conflicts: { word: string; present: number[]; absent: number[] }[] = [];
        const allWords = new Set(wordSets.flatMap(s => Array.from(s)));

        for (const word of allWords) {
            const present: number[] = [];
            const absent: number[] = [];
            wordSets.forEach((ws, i) => {
                (ws.has(word) ? present : absent).push(i + 1);
            });
            if (present.length > 0 && absent.length > 0 && word.length > 4) {
                conflicts.push({ word, present, absent });
            }
        }

        const topConflicts = conflicts
            .sort((a, b) => (b.present.length + b.absent.length) - (a.present.length + a.absent.length))
            .slice(0, 15);

        return textResult([
            `# Conflict Detection: ${topic}`,
            '',
            `**Texts analyzed:** ${resolved.length} | **Potential conflicts found:** ${conflicts.length}`,
            '',
            '## Top Conflicts (terms appearing in some texts but not others)',
            '',
            '| Term | In Texts | Missing From |',
            '|---|---|---|',
            ...topConflicts.map(c =>
                `| ${c.word} | ${c.present.join(', ')} | ${c.absent.join(', ')} |`
            ),
            '',
            '## Text Summaries',
            ...resolved.map((r, i) =>
                `### Text ${i + 1}: ${r.title}\n- Words: ${r.text.split(/\s+/).length.toLocaleString()}\n- Preview: ${r.text.slice(0, 200)}...\n`
            ),
            '',
            '## Next Steps',
            '- These are *candidate* conflicts — keyword-level only',
            '- Human review needed to confirm genuine disagreements vs. different terminology',
            '- Use `harmony_evidence_matrix` to map specific claims from each text',
        ].join('\n'));
    }

    async prepareInvocation() {
        return { invocationMessage: 'Detecting conflicts across texts' };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 4b: Citation Influence
// ═══════════════════════════════════════════════════════════════════════════════

interface CitationInfluenceInput {
    doi?: string;
    title?: string;
    paper_id?: string;  // Semantic Scholar paper ID
}

class CitationInfluenceTool implements vscode.LanguageModelTool<CitationInfluenceInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<CitationInfluenceInput>) {
        const input = options.input;
        let paperId = input.paper_id;

        // Resolve DOI → Semantic Scholar ID
        if (!paperId && input.doi) {
            try {
                const url = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(input.doi)}?fields=paperId,title,citationCount,influentialCitationCount`;
                const json: any = await (await fetch(url, {
                    headers: { 'User-Agent': 'Harmony-Research/0.3.0' },
                    signal: AbortSignal.timeout(10000),
                })).json();
                paperId = json.paperId;
                if (!paperId) {
                    return textResult(`error: could not find paper for DOI: ${input.doi}`);
                }
            } catch (e: any) {
                return textResult(`error: Semantic Scholar lookup failed: ${e?.message ?? String(e)}`);
            }
        }

        // Search by title
        if (!paperId && input.title) {
            try {
                const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(input.title)}&limit=1&fields=paperId,title,citationCount`;
                const json: any = await (await fetch(url, {
                    headers: { 'User-Agent': 'Harmony-Research/0.3.0' },
                    signal: AbortSignal.timeout(10000),
                })).json();
                paperId = json?.data?.[0]?.paperId;
            } catch { /* graceful */ }
        }

        if (!paperId) {
            return textResult('error: provide doi, title, or paper_id to look up a paper');
        }

        // Fetch citation details
        try {
            const url = `https://api.semanticscholar.org/graph/v1/paper/${paperId}?fields=title,authors,year,citationCount,influentialCitationCount,citations.title,citations.citationCount,citations.year,references.title,references.citationCount,references.year`;
            const json: any = await (await fetch(url, {
                headers: { 'User-Agent': 'Harmony-Research/0.3.0' },
                signal: AbortSignal.timeout(10000),
            })).json();

            const title = json.title ?? 'Unknown';
            const year = json.year ?? '?';
            const citations = json.citationCount ?? 0;
            const influential = json.influentialCitationCount ?? 0;
            const topCiting = (json.citations ?? []).slice(0, 5);
            const topRefs = (json.references ?? []).slice(0, 5);

            // Heuristic: a paper is "seminal" if it has many citations from highly-cited papers
            const citingAvg = topCiting.length
                ? Math.round(topCiting.reduce((sum: number, c: any) => sum + (c.citationCount ?? 0), 0) / topCiting.length)
                : 0;
            const rank = citations > 1000 ? '🟢 Seminal'
                : citations > 100 ? '🟡 Established'
                : citations > 10 ? '🟠 Emerging'
                : '🔴 Early-stage';

            return textResult([
                `# Citation Influence: ${title}`,
                '',
                `| Metric | Value |`,
                `|---|---|`,
                `| **Year** | ${year} |`,
                `| **Total Citations** | ${citations.toLocaleString()} |`,
                `| **Influential Citations** | ${influential.toLocaleString()} |`,
                `| **Avg Citing Paper Citations** | ${citingAvg.toLocaleString()} |`,
                `| **Influence Rank** | ${rank} |`,
                '',
                '## Top Citing Papers',
                ...topCiting.map((c: any, i: number) =>
                    `- ${c.title ?? 'Untitled'} (${c.year ?? '?'}, ${(c.citationCount ?? 0).toLocaleString()} citations)`
                ),
                '',
                '## Top References',
                ...topRefs.map((r: any, i: number) =>
                    `- ${r.title ?? 'Untitled'} (${r.year ?? '?'}, ${(r.citationCount ?? 0).toLocaleString()} citations)`
                ),
                '',
                '## Verdict',
                rank === '🟢 Seminal'
                    ? 'This paper is highly influential. Building on its findings is well-supported by the field.'
                    : rank === '🟡 Established'
                        ? 'This paper is well-cited. It represents established knowledge in the field.'
                        : rank === '🟠 Emerging'
                            ? 'This paper has moderate citations. Verify findings are replicated before relying heavily.'
                            : 'This paper has few citations. Treat findings as preliminary until replicated.',
            ].join('\n'));
        } catch (e: any) {
            return textResult(`error: Semantic Scholar lookup failed: ${e?.message ?? String(e)}`);
        }
    }

    async prepareInvocation() {
        return { invocationMessage: 'Analyzing citation influence' };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 5: Research State Machine
// ═══════════════════════════════════════════════════════════════════════════════

interface ResearchProjectData {
    id: string;
    topic: string;
    state: 'briefing' | 'scanning' | 'evidence' | 'synthesis' | 'publication';
    createdAt: string;
    updatedAt: string;
    steps: { tool: string; result: string; at: string }[];
}

class ResearchStateTool implements vscode.LanguageModelTool<{ action: string; project_id?: string; topic?: string; state?: string }> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<{ action: string; project_id?: string; topic?: string; state?: string }>) {
        const input = options.input;
        const root = workspaceRoot();
        if (!root) return textResult('error: no workspace folder open');

        const projectsDir = path.join(root, PROJECTS_DIR);
        await ensureDir(projectsDir);

        const action = input.action ?? 'list';

        if (action === 'create' && input.topic) {
            const id = `proj-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
            const project: ResearchProjectData = {
                id,
                topic: input.topic,
                state: 'briefing',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                steps: [],
            };
            await fs.writeFile(
                path.join(projectsDir, `${id}.json`),
                JSON.stringify(project, null, 2),
                'utf8'
            );
            return textResult(`# Research Project Created\n\n**ID:** \`${id}\`\n**Topic:** ${input.topic}\n**State:** briefing\n\nNext: Run \`harmony_research_brief\` with this topic.`);
        }

        if (action === 'list') {
            const files = await fs.readdir(projectsDir).catch(() => [] as string[]);
            const projects: ResearchProjectData[] = [];
            for (const file of files.filter(f => f.endsWith('.json')).slice(0, 20)) {
                try {
                    projects.push(JSON.parse(await fs.readFile(path.join(projectsDir, file), 'utf8')));
                } catch { /* skip malformed */ }
            }

            if (!projects.length) {
                return textResult('No research projects yet. Create one with `action: "create"` and a `topic`.');
            }

            return textResult([
                '# Research Projects',
                '',
                '| ID | Topic | State | Updated |',
                '|---|---|---|---|',
                ...projects.map(p =>
                    `| \`${p.id}\` | ${p.topic.slice(0, 50)} | ${p.state} | ${p.updatedAt.slice(0, 10)} |`
                ),
            ].join('\n'));
        }

        if (action === 'advance' && input.project_id && input.state) {
            const projectPath = path.join(projectsDir, `${input.project_id}.json`);
            try {
                const project: ResearchProjectData = JSON.parse(await fs.readFile(projectPath, 'utf8'));
                const validStates = ['briefing', 'scanning', 'evidence', 'synthesis', 'publication'];
                if (!validStates.includes(input.state)) {
                    return textResult(`error: invalid state. Must be one of: ${validStates.join(', ')}`);
                }
                project.state = input.state as ResearchProjectData['state'];
                project.updatedAt = new Date().toISOString();
                await fs.writeFile(projectPath, JSON.stringify(project, null, 2), 'utf8');
                return textResult(`# State Advanced\n\n**Project:** ${project.topic}\n**State:** ${input.state}\n\nNext steps depend on the new state.`);
            } catch {
                return textResult(`error: project not found: ${input.project_id}`);
            }
        }

        return textResult('error: use action "create" (with topic), "list", or "advance" (with project_id + state)');
    }

    async prepareInvocation() {
        return { invocationMessage: 'Managing research project' };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 6: Code Theory Bridge
// ═══════════════════════════════════════════════════════════════════════════════

interface CodeTheoryInput {
    file_path?: string;
    symbol?: string;
    algorithm?: string;
}

class CodeTheoryBridgeTool implements vscode.LanguageModelTool<CodeTheoryInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<CodeTheoryInput>) {
        const input = options.input;
        const root = workspaceRoot();

        // Extract code context
        let codeContext = '';
        let query = '';

        if (input.file_path && root) {
            const resolved = path.isAbsolute(input.file_path)
                ? input.file_path
                : path.resolve(root, input.file_path);
            try {
                const content = await fs.readFile(resolved, 'utf8');
                codeContext = content.slice(0, 3000);
                query = input.algorithm || input.symbol || path.basename(resolved);
            } catch (e: any) {
                return textResult(`error: could not read file: ${e?.message ?? String(e)}`);
            }
        }

        if (input.symbol) {
            query = query || input.symbol;
            codeContext = codeContext || `Symbol: ${input.symbol}`;
        }

        if (input.algorithm) {
            query = input.algorithm;
            codeContext = codeContext || `Algorithm: ${input.algorithm}`;
        }

        if (!query) return textResult('error: provide file_path, symbol, or algorithm');

        // Search literature for the algorithm/symbol
        let papers: any[] = [];
        try {
            const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=5&fields=title,authors,year,url,abstract,citationCount`;
            const json: any = await (await fetch(url, {
                headers: { 'User-Agent': 'Harmony-Research/0.3.0' },
                signal: AbortSignal.timeout(10000),
            })).json();
            papers = json?.data ?? [];
        } catch { /* graceful */ }

        return textResult([
            `# Code ↔ Theory Bridge: ${query}`,
            '',
            '## Code Context',
            '```',
            codeContext.slice(0, 1500) || `Looking up: ${query}`,
            '```',
            '',
            '## Related Academic Papers',
            papers.length
                ? papers.map((p: any, i: number) => {
                    const authors = Array.isArray(p.authors)
                        ? p.authors.slice(0, 3).map((a: any) => a.name).filter(Boolean).join(', ')
                        : '';
                    return `### ${i + 1}. ${p.title}\n- **Year:** ${p.year ?? '?'} | **Citations:** ${(p.citationCount ?? 0).toLocaleString()}\n- **Authors:** ${authors}\n- **URL:** ${p.url ?? 'N/A'}\n- **Abstract:** ${(p.abstract ?? '').slice(0, 300)}`;
                }).join('\n\n')
                : 'No papers found for this term.',
            '',
            '## Next Steps',
            '- `harmony_pdf_ingest` the top paper for deeper analysis',
            '- `harmony_citation_influence` to check if the paper is seminal',
            '- `harmony_evidence_matrix` to map your implementation against the literature',
        ].join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<CodeTheoryInput>) {
        const label = options.input.symbol || options.input.algorithm || options.input.file_path || 'code';
        return { invocationMessage: `Bridging code to theory: ${label}` };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 7: CareBloom Pipeline Optimization
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pipeline analytics — tracks which pipelines are used, success rates,
 * and suggests optimization patterns. Leverages CareBloom's existing
 * sprout infrastructure for learning over time.
 */

export interface PipelineAnalytics {
    pipeline: string;
    runs: number;
    successes: number;
    avgDurationMs: number;
    lastRun: string;
    topError?: string;
}

const ANALYTICS_PATH = '.harmony/pipeline-analytics.json';

async function loadAnalytics(): Promise<PipelineAnalytics[]> {
    const root = workspaceRoot();
    if (!root) return [];
    try {
        return JSON.parse(await fs.readFile(path.join(root, ANALYTICS_PATH), 'utf8'));
    } catch {
        return [];
    }
}

async function saveAnalytics(analytics: PipelineAnalytics[]): Promise<void> {
    const root = workspaceRoot();
    if (!root) return;
    await ensureDir(path.join(root, '.harmony'));
    await fs.writeFile(
        path.join(root, ANALYTICS_PATH),
        JSON.stringify(analytics, null, 2),
        'utf8'
    );
}

export async function recordPipelineRun(
    pipeline: string,
    ok: boolean,
    durationMs: number,
    error?: string,
): Promise<void> {
    const analytics = await loadAnalytics();
    const existing = analytics.find(a => a.pipeline === pipeline);

    if (existing) {
        existing.runs++;
        if (ok) existing.successes++;
        existing.avgDurationMs = Math.round(
            (existing.avgDurationMs * (existing.runs - 1) + durationMs) / existing.runs
        );
        existing.lastRun = new Date().toISOString();
        if (error) existing.topError = error;
    } else {
        analytics.push({
            pipeline,
            runs: 1,
            successes: ok ? 1 : 0,
            avgDurationMs: durationMs,
            lastRun: new Date().toISOString(),
            topError: error,
        });
    }

    await saveAnalytics(analytics.slice(-50)); // Cap at 50 entries
}

// ── Tokenizer helper ────────────────────────────────────────────────────────

const STOP_WORDS = new Set(['about', 'after', 'again', 'also', 'because', 'before', 'between', 'could', 'from', 'have', 'into', 'should', 'their', 'there', 'these', 'this', 'that', 'with', 'would']);

function tokenize(text: string): string[] {
    return Array.from(new Set(
        (text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])
            .filter(w => !STOP_WORDS.has(w))
    ));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Registration
// ═══════════════════════════════════════════════════════════════════════════════

export function registerResearchUpgradeTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_pdf_ingest', new PdfIngestTool()),
        vscode.lm.registerTool('harmony_conflict_detector', new ConflictDetectorTool()),
        vscode.lm.registerTool('harmony_citation_influence', new CitationInfluenceTool()),
        vscode.lm.registerTool('harmony_research_state', new ResearchStateTool()),
        vscode.lm.registerTool('harmony_code_theory_bridge', new CodeTheoryBridgeTool()),
    );
}
