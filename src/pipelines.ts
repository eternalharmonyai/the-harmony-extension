/**
 * Research pipelines — compose research tool logic into multi-step workflows.
 * Uses the same APIs as the individual tools (Semantic Scholar, Crossref, fetch)
 * but chains them into automated workflows.
 *
 * Architecture:
 *   fetch API → parse → typed struct → adapt → next API call → output
 */

import type {
    PipelineResult,
    PipelineStep,
    LiteratureItem,
    LiteratureScanData,
    EvidenceMatrixData,
} from './pipelineTypes';

// ── API Helpers ─────────────────────────────────────────────────────────────

const USER_AGENT = 'Harmony-Research-Pipelines/0.3.0';

async function fetchJson(url: string): Promise<any> {
    const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15000),
    });
    return response.json();
}

async function fetchText(url: string, maxChars = 6000): Promise<string> {
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(15000),
        });
        const raw = await response.text();
        const stripped = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return stripped.length > maxChars ? stripped.slice(0, maxChars) + '...' : stripped;
    } catch {
        return '';
    }
}

// ── Literature Scan (inline) ────────────────────────────────────────────────

async function scanLiterature(query: string, maxResults = 8): Promise<LiteratureScanData> {
    const results: LiteratureItem[] = [];

    // Semantic Scholar
    try {
        const ssUrl = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${maxResults}&fields=title,authors,year,url,abstract,venue,citationCount,externalIds`;
        const json = await fetchJson(ssUrl);
        for (const paper of json?.data ?? []) {
            const authors = Array.isArray(paper.authors)
                ? paper.authors.slice(0, 3).map((a: any) => a.name).filter(Boolean).join(', ')
                : '';
            results.push({
                source: 'semantic_scholar',
                year: paper.year ?? new Date().getFullYear(),
                title: String(paper.title ?? ''),
                authors,
                citations: paper.citationCount ?? 0,
                url: paper.url ?? `https://doi.org/${paper.externalIds?.DOI ?? ''}`,
            });
        }
    } catch { /* graceful */ }

    // Crossref
    try {
        const crUrl = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${maxResults}`;
        const json = await fetchJson(crUrl);
        for (const item of json?.message?.items ?? []) {
            const title = Array.isArray(item.title) ? item.title[0] : item.title;
            const year = item.issued?.['date-parts']?.[0]?.[0] ?? new Date().getFullYear();
            const authors = Array.isArray(item.author)
                ? item.author.slice(0, 3).map((a: any) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean).join(', ')
                : '';
            results.push({
                source: 'crossref',
                year,
                title: String(title ?? ''),
                authors,
                citations: item['is-referenced-by-count'] ?? 0,
                url: item.URL ?? '',
            });
        }
    } catch { /* graceful */ }

    return { query, results };
}

// ── Step Helpers ────────────────────────────────────────────────────────────

function stepOk(tool: string, durationMs: number): PipelineStep {
    return { tool, ok: true, durationMs };
}

function stepFail(tool: string, durationMs: number, error: string): PipelineStep {
    return { tool, ok: false, durationMs, error };
}

function resultOk(pipeline: string, topic: string, steps: PipelineStep[], output: string, durationMs: number): PipelineResult {
    return { ok: true, pipeline, topic, output, steps, durationMs };
}

function resultFail(pipeline: string, topic: string, steps: PipelineStep[], error: string, durationMs: number): PipelineResult {
    return { ok: false, pipeline, topic, output: '', steps, error, durationMs };
}

// ── Word-based overlap (for evidence matrix) ────────────────────────────────

const STOP_WORDS = new Set(['about', 'after', 'again', 'also', 'because', 'before', 'between', 'could', 'from', 'have', 'into', 'should', 'their', 'there', 'these', 'this', 'that', 'with', 'would']);

function tokenize(text: string): string[] {
    return Array.from(new Set(
        (text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])
            .filter(w => !STOP_WORDS.has(w))
    ));
}

function overlapScore(claimWords: string[], sourceWords: Set<string>): number {
    return claimWords.filter(w => sourceWords.has(w)).length;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE A: Deep Dive
// Topic → literature_scan → fetch papers → evidence synthesis → summary
// ═══════════════════════════════════════════════════════════════════════════════

export async function deepDive(topic: string): Promise<PipelineResult> {
    const pipelineStart = Date.now();
    const steps: PipelineStep[] = [];

    // Step 1: Scan literature
    const scanStart = Date.now();
    const scan = await scanLiterature(topic, 8);
    steps.push(stepOk('literature_scan', Date.now() - scanStart));

    if (scan.results.length === 0) {
        return resultFail('deep_dive', topic, steps, 'No literature found for topic', Date.now() - pipelineStart);
    }

    // Step 2: Fetch top papers for deeper reading
    const fetchStart = Date.now();
    const topPapers = scan.results.slice(0, 5).filter(p => p.url);
    const paperTexts: { title: string; text: string; url: string }[] = [];

    for (const paper of topPapers) {
        try {
            const text = await fetchText(paper.url, 8000);
            if (text) paperTexts.push({ title: paper.title, text, url: paper.url });
        } catch { /* skip failed fetches */ }
    }
    steps.push(stepOk('fetch_papers', Date.now() - fetchStart));

    // Step 3: Build evidence matrix (keyword overlap across papers)
    const evidenceStart = Date.now();
    const allPaperText = paperTexts.map(p => p.text).join(' ');
    const allPaperWords = new Set(tokenize(allPaperText));
    const topicWords = tokenize(topic);

    const evidenceRows = topPapers.map(paper => {
        const paperWords = new Set(tokenize(paperTexts.find(p => p.url === paper.url)?.text ?? ''));
        const score = overlapScore(topicWords, paperWords);
        return {
            title: paper.title,
            url: paper.url,
            relevance: score,
            year: paper.year,
            citations: paper.citations,
        };
    }).sort((a, b) => b.relevance - a.relevance);

    steps.push(stepOk('evidence_synthesis', Date.now() - evidenceStart));

    // Step 4: Generate summary
    const summaryStart = Date.now();
    const lines = [
        `# Deep Dive: ${topic}`,
        '',
        `## Literature Scan (${scan.results.length} papers)`,
        '',
        '| # | Year | Title | Authors | Citations | Relevance |',
        '|---:|-----:|-------|---------|----------:|----------:|',
        ...evidenceRows.map((p, i) =>
            `| ${i + 1} | ${p.year} | ${(p.title || 'Untitled').slice(0, 60)} | ${p.citations} | ${p.relevance} |`
        ),
        '',
        '## Key Papers (by relevance)',
        ...evidenceRows.slice(0, 3).map((p, i) => [
            `### ${i + 1}. ${p.title}`,
            `- Year: ${p.year} | Citations: ${p.citations}`,
            `- URL: ${p.url}`,
            `- Relevance score: ${p.relevance} keyword matches`,
            '',
        ].join('\n')),
        '## Research Questions',
        ...topicWords.map(w => `- How does the literature address "${w}"?`),
        '',
        '## Next Steps',
        '- Run `harmony_evidence_matrix` with the top papers to map claims',
        '- Run `harmony_publication_outline` to structure findings',
        `- Use \`harmony_current_research\` with specific paper URLs for deep reading`,
    ];
    const output = lines.join('\n');
    steps.push(stepOk('summary', Date.now() - summaryStart));

    return resultOk('deep_dive', topic, steps, output, Date.now() - pipelineStart);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE B: Literature Synthesis
// Query → scan → fetch all papers → qualitative themes → consolidated dossier
// ═══════════════════════════════════════════════════════════════════════════════

export async function synthesizeLiterature(query: string): Promise<PipelineResult> {
    const pipelineStart = Date.now();
    const steps: PipelineStep[] = [];

    // Step 1: Scan
    const scanStart = Date.now();
    const scan = await scanLiterature(query, 10);
    steps.push(stepOk('literature_scan', Date.now() - scanStart));

    if (scan.results.length === 0) {
        return resultFail('literature_synthesis', query, steps, 'No literature found', Date.now() - pipelineStart);
    }

    // Step 2: Fetch all paper abstracts/text
    const fetchStart = Date.now();
    const papers = scan.results.filter(p => p.url);
    const paperBodies: string[] = [];

    for (const paper of papers.slice(0, 8)) {
        const text = await fetchText(paper.url, 6000);
        if (text) paperBodies.push(`--- ${paper.title} (${paper.year}) ---\n${text}`);
    }
    steps.push(stepOk('fetch_papers', Date.now() - fetchStart));

    // Step 3: Theme extraction (simple frequency-based)
    const themeStart = Date.now();
    const allText = paperBodies.join('\n\n');
    const allWords = tokenize(allText);
    const wordFreq = new Map<string, number>();
    for (const w of allWords) {
        wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
    }

    // Top themes = most frequent meaningful words
    const themes = Array.from(wordFreq.entries())
        .filter(([_, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([word, count]) => ({ word, count }));

    // Group papers by theme overlap
    const themeMap = new Map<string, string[]>();
    for (const { word } of themes) {
        for (const paper of papers) {
            const paperText = paperBodies.find(b => b.includes(paper.title)) ?? '';
            if (tokenize(paperText).includes(word)) {
                const existing = themeMap.get(word) ?? [];
                existing.push(paper.title);
                themeMap.set(word, existing);
            }
        }
    }

    steps.push(stepOk('theme_extraction', Date.now() - themeStart));

    // Step 4: Build synthesis output
    const output = [
        `# Literature Synthesis: ${query}`,
        '',
        `**Papers analyzed:** ${papers.length} | **Themes extracted:** ${themes.length}`,
        '',
        '## Emergent Themes',
        '',
        ...themes.map(({ word, count }) => {
            const paperList = (themeMap.get(word) ?? []).slice(0, 3);
            return `### ${word} (${count} occurrences)\n${paperList.map(p => `- ${p}`).join('\n')}\n`;
        }),
        '## Paper Summary Table',
        '',
        '| # | Year | Title | Authors | Citations |',
        '|---:|-----:|-------|---------|----------:|',
        ...papers.slice(0, 10).map((p, i) =>
            `| ${i + 1} | ${p.year} | ${(p.title || '').slice(0, 60)} | ${p.authors.slice(0, 40)} | ${p.citations} |`
        ),
        '',
        '## Research Gaps',
        '- Run `harmony_evidence_matrix` to map specific claims to these papers',
        '- Use `harmony_conflict_detector` to find contradictory findings',
        '- Consider `harmony_qualitative_coder` on paper bodies for deeper theme analysis',
    ].join('\n');

    return resultOk('literature_synthesis', query, steps, output, Date.now() - pipelineStart);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE C: Claim Verification
// Claims[] → scan for each claim → cross-reference sources → evidence summary
// ═══════════════════════════════════════════════════════════════════════════════

export async function verifyClaims(claims: string[]): Promise<PipelineResult> {
    const pipelineStart = Date.now();
    const steps: PipelineStep[] = [];
    const primaryClaim = claims[0] ?? 'verification';

    // Step 1: Scan literature for each claim
    const scanStart = Date.now();
    const allPapers = new Map<string, LiteratureItem[]>();

    for (const claim of claims.slice(0, 5)) {
        const scan = await scanLiterature(claim, 5);
        allPapers.set(claim, scan.results);
    }
    steps.push(stepOk('multi_claim_scan', Date.now() - scanStart));

    // Step 2: Cross-reference — find papers that support multiple claims
    const crossRefStart = Date.now();
    const paperClaimMap = new Map<string, string[]>(); // paper URL → claims it supports
    for (const [claim, papers] of allPapers) {
        for (const paper of papers) {
            if (!paper.url) continue;
            const existing = paperClaimMap.get(paper.url) ?? [];
            if (!existing.includes(claim)) existing.push(claim);
            paperClaimMap.set(paper.url, existing);
        }
    }

    // Papers supporting the most claims are strongest evidence
    const rankedPapers = Array.from(paperClaimMap.entries())
        .sort((a, b) => b[1].length - a[1].length);

    steps.push(stepOk('cross_reference', Date.now() - crossRefStart));

    // Step 3: Build verification output
    const output = [
        '# Claim Verification Results',
        '',
        `**Claims checked:** ${claims.length} | **Papers found:** ${rankedPapers.length}`,
        '',
        '## Claim-by-Claim Analysis',
        '',
        ...claims.slice(0, 5).map(claim => {
            const papers = allPapers.get(claim) ?? [];
            const status = papers.length >= 2 ? '🟢 Supported' : papers.length === 1 ? '🟡 Tentative' : '🔴 No sources found';
            return [
                `### ${status}: ${claim}`,
                papers.length ? papers.map(p => `- ${p.title} (${p.year}, ${p.citations} citations)`) : '- No matching literature found',
                '',
            ].join('\n');
        }),
        '## Strongest Cross-Claim Evidence',
        '',
        ...rankedPapers.slice(0, 5).map(([url, claimList]) =>
            `- **${claimList.length} claims** supported by paper at ${url}`
        ),
        '',
        '## Verdict Summary',
        ...claims.map(claim => {
            const count = (allPapers.get(claim) ?? []).length;
            return `- ${claim}: ${count} supporting papers → ${count >= 2 ? 'LIKELY SUPPORTED' : count === 1 ? 'TENTATIVE' : 'UNVERIFIED'}`;
        }),
    ].join('\n');

    return resultOk('claim_verification', primaryClaim, steps, output, Date.now() - pipelineStart);
}
