/**
 * Pipeline parsers — extract structured data from tool markdown output.
 * Each parser takes the raw markdown string from a tool invocation
 * and returns a typed intermediate struct for the next pipeline step.
 */

import type {
    ResearchBriefData,
    LiteratureItem,
    LiteratureScanData,
    ClaimEvidence,
    EvidenceMatrixData,
    ResearchDossierData,
    PublicationOutlineData,
    SectionOutline,
    SourceLedgerEntry,
    ClaimCheckResult,
} from './pipelineTypes';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Extract a markdown section body by heading title. */
function extractSection(markdown: string, heading: string): string {
    const re = new RegExp(`##\\s+${escapeRegex(heading)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
    const m = markdown.match(re);
    return (m?.[1] ?? '').trim();
}

/** Parse bullet list items from section text. */
function parseBullets(text: string): string[] {
    return text.split('\n')
        .map(line => line.replace(/^[-*]\s+/, '').trim())
        .filter(Boolean);
}

/** Escape regex special characters. */
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse a markdown table into rows of string arrays. */
function parseTable(markdown: string): string[][] {
    const lines = markdown.split('\n');
    const rows: string[][] = [];
    for (const line of lines) {
        if (line.startsWith('|') && !line.includes('---')) {
            const cells = line.split('|').map(c => c.trim()).filter(c => c.length > 0);
            if (cells.length >= 2) rows.push(cells);
        }
    }
    return rows;
}

// ── Research Brief Parser ───────────────────────────────────────────────────

export function parseResearchBrief(markdown: string, topic: string): ResearchBriefData {
    const questionsSection = extractSection(markdown, 'Core Research Questions');
    const bucketsSection = extractSection(markdown, 'Evidence Buckets');
    const sourcesSection = extractSection(markdown, 'Fetched Source Notes');

    return {
        topic,
        audience: extractField(markdown, 'Audience:') || 'public-interest / research audience',
        outputType: extractField(markdown, 'Output type:') || 'article',
        thesis: extractField(markdown, 'Working thesis:') || 'to be refined after evidence review',
        researchQuestions: parseBullets(questionsSection),
        evidenceBuckets: parseBullets(bucketsSection),
        sourceNotes: parseBullets(sourcesSection),
    };
}

function extractField(markdown: string, prefix: string): string | undefined {
    const line = markdown.split('\n').find(l => l.trim().startsWith(prefix));
    return line?.replace(prefix, '').trim();
}

// ── Literature Scan Parser ──────────────────────────────────────────────────

export function parseLiteratureScan(markdown: string, query: string): LiteratureScanData {
    const rows = parseTable(markdown);
    const results: LiteratureItem[] = [];

    for (const row of rows) {
        if (row.length >= 6 && (row[0] === 'Semantic Scholar' || row[0] === 'Crossref')) {
            const citations = parseInt(row[4], 10) || 0;
            const year = parseInt(row[1], 10) || new Date().getFullYear();
            results.push({
                source: row[0] as 'semantic_scholar' | 'crossref',
                year,
                title: row[2],
                authors: row[3],
                citations,
                url: row[5],
            });
        }
    }

    return { query, results };
}

// ── Evidence Matrix Parser ──────────────────────────────────────────────────

export function parseEvidenceMatrix(markdown: string): EvidenceMatrixData {
    const rows = parseTable(markdown);
    const claims: ClaimEvidence[] = [];

    for (const row of rows) {
        if (row.length >= 4 && row[0] !== 'Claim') {
            const status = row[1] as ClaimEvidence['status'];
            claims.push({
                claim: row[0],
                status: ['candidate support', 'needs source', 'contradictory', 'weak'].includes(status)
                    ? status : 'needs source',
                bestSourceUrl: row[2] || '',
                keywordOverlap: row[3] ? row[3].split(',').map(s => s.trim()) : [],
            });
        }
    }

    const notes = extractSection(markdown, 'Research Notes');

    return { claims, notes };
}

// ── Research Dossier Parser ─────────────────────────────────────────────────

export function parseResearchDossier(markdown: string, query: string): ResearchDossierData {
    const contradictions = parseBullets(extractSection(markdown, 'Contradictions'));
    const consensus = parseBullets(extractSection(markdown, 'Consensus'));
    const gaps = parseBullets(extractSection(markdown, 'Knowledge Gaps'));
    const synthesis = extractSection(markdown, 'Synthesis');

    return {
        query,
        contradictions,
        consensus,
        gaps,
        synthesis: synthesis || markdown.slice(0, 2000), // fallback
    };
}

// ── Publication Outline Parser ──────────────────────────────────────────────

export function parsePublicationOutline(markdown: string, topic: string): PublicationOutlineData {
    const structureSection = extractSection(markdown, 'Recommended Structure');
    const structure: SectionOutline[] = parseBullets(structureSection).map(bullet => {
        const colonIdx = bullet.indexOf(':');
        if (colonIdx > 0) {
            return { title: bullet.slice(0, colonIdx).trim(), description: bullet.slice(colonIdx + 1).trim() };
        }
        return { title: bullet, description: '' };
    });

    return {
        topic,
        audience: extractField(markdown, 'Audience:') || 'public-interest readers',
        format: extractField(markdown, 'Format:') || 'research-backed article',
        structure,
        findings: extractSection(markdown, 'Findings To Place'),
        sourceSlots: parseBullets(extractSection(markdown, 'Source Slots')),
        prePublishChecks: parseBullets(extractSection(markdown, 'Pre-Publish Checks')),
    };
}

// ── Source Ledger Parser ────────────────────────────────────────────────────

export function parseSourceLedger(markdown: string): SourceLedgerEntry[] {
    const rows = parseTable(markdown);
    const entries: SourceLedgerEntry[] = [];

    for (const row of rows) {
        if (row.length >= 3 && row[0] !== 'URL' && row[0] !== 'ID') {
            entries.push({
                url: row[0],
                title: row[1] || undefined,
                fetchedAt: row[2] || new Date().toISOString(),
                rating: 'moderate',
            });
        }
    }

    return entries;
}

// ── Claim Check Parser ─────────────────────────────────────────────────────

export function parseClaimCheck(markdown: string, claim: string): ClaimCheckResult {
    const verdictSection = extractSection(markdown, 'Verdict');
    const sourcesSection = extractSection(markdown, 'Supporting Sources');
    const summary = extractSection(markdown, 'Summary');

    let verdict: ClaimCheckResult['verdict'] = 'inconclusive';
    if (/supported|verified|confirmed/i.test(verdictSection)) verdict = 'supported';
    else if (/contradicted|refuted|disputed/i.test(verdictSection)) verdict = 'contradicted';
    else if (/error|failed/i.test(verdictSection)) verdict = 'error';

    const sourceBullets = parseBullets(sourcesSection);
    const sources: SourceLedgerEntry[] = sourceBullets.map((b, i) => ({
        url: `source-${i + 1}`,
        title: b.slice(0, 120),
        fetchedAt: new Date().toISOString(),
        rating: 'moderate' as const,
    }));

    return { claim, verdict, sources, summary };
}
