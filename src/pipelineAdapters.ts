/**
 * Pipeline adapters — transform intermediate structs between tool schemas.
 * Each adapter converts the output of one tool into the input format
 * expected by the next tool in the pipeline chain.
 */

import type {
    ResearchBriefData,
    LiteratureItem,
    LiteratureScanData,
    ClaimEvidence,
    EvidenceMatrixData,
    ResearchDossierData,
} from './pipelineTypes';

// ── Brief → Literature Scan ─────────────────────────────────────────────────

/**
 * Convert research brief into literature scan queries.
 * Uses the first N suggested queries from the brief.
 */
export function briefToScanQueries(brief: ResearchBriefData, maxQueries = 3): string[] {
    const candidates = [
        brief.topic,
        ...brief.researchQuestions.slice(0, maxQueries - 1),
    ];
    return candidates.filter(q => q.length > 5).slice(0, maxQueries);
}

// ── Literature Scan → Evidence Matrix ───────────────────────────────────────

/** Feed item for evidence_matrix — maps a paper to the format the tool expects. */
export interface EvidenceFeedItem {
    url: string;
    title: string;
    authors?: string;
    year?: number;
}

/**
 * Convert literature scan results into evidence matrix feed items.
 * Filters out papers without URLs and deduplicates by DOI/URL.
 */
export function scanToEvidenceFeed(results: LiteratureItem[]): EvidenceFeedItem[] {
    const seen = new Set<string>();
    const feed: EvidenceFeedItem[] = [];

    for (const paper of results) {
        if (!paper.url || seen.has(paper.url)) continue;
        seen.add(paper.url);
        feed.push({
            url: paper.url,
            title: paper.title,
            authors: paper.authors || undefined,
            year: paper.year || undefined,
        });
    }

    return feed;
}

// ── Literature Scan → Current Research ──────────────────────────────────────

/**
 * Extract URLs from literature scan for current_research tool.
 * Returns up to maxUrls unique paper URLs.
 */
export function scanToUrls(results: LiteratureItem[], maxUrls = 8): string[] {
    const seen = new Set<string>();
    const urls: string[] = [];

    for (const paper of results) {
        if (!paper.url || seen.has(paper.url)) continue;
        seen.add(paper.url);
        urls.push(paper.url);
        if (urls.length >= maxUrls) break;
    }

    return urls;
}

// ── Evidence Matrix → Publication Outline ───────────────────────────────────

/**
 * Convert evidence matrix claims into publication outline findings.
 * Formats supported claims as evidence bullets, flags gaps.
 */
export function matrixToFindings(matrix: EvidenceMatrixData): string {
    const supported = matrix.claims.filter(c => c.status === 'candidate support');
    const needsSource = matrix.claims.filter(c => c.status === 'needs source');
    const contradictory = matrix.claims.filter(c => c.status === 'contradictory');

    const parts: string[] = [];

    if (supported.length) {
        parts.push('Supported claims:');
        supported.forEach(c => parts.push(`- ${c.claim} [source: ${c.bestSourceUrl}]`));
    }

    if (contradictory.length) {
        parts.push('');
        parts.push('Contradictory or contested claims:');
        contradictory.forEach(c => parts.push(`- ${c.claim} (requires deeper review)`));
    }

    if (needsSource.length) {
        parts.push('');
        parts.push('Claims needing additional sources:');
        needsSource.forEach(c => parts.push(`- ${c.claim}`));
    }

    return parts.join('\n') || 'No claims categorized yet.';
}

// ── Evidence Matrix → Source URLs ───────────────────────────────────────────

/**
 * Extract unique source URLs from evidence matrix for further investigation.
 */
export function matrixToSourceUrls(matrix: EvidenceMatrixData): string[] {
    const urls = new Set<string>();
    for (const claim of matrix.claims) {
        if (claim.bestSourceUrl) urls.add(claim.bestSourceUrl);
    }
    return Array.from(urls);
}

// ── Dossier → Publication Outline ───────────────────────────────────────────

/**
 * Convert research dossier contradictions and gaps into
 * publication outline findings with structured notes.
 */
export function dossierToFindings(dossier: ResearchDossierData): string {
    const parts: string[] = [];

    if (dossier.consensus.length) {
        parts.push('Areas of consensus:');
        dossier.consensus.forEach(c => parts.push(`- ${c}`));
    }

    if (dossier.contradictions.length) {
        parts.push('');
        parts.push('Unresolved contradictions:');
        dossier.contradictions.forEach(c => parts.push(`- ${c}`));
    }

    if (dossier.gaps.length) {
        parts.push('');
        parts.push('Knowledge gaps identified:');
        dossier.gaps.forEach(g => parts.push(`- ${g}`));
    }

    return parts.join('\n') || dossier.synthesis.slice(0, 1000);
}
