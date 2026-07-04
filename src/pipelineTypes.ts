/**
 * Pipeline intermediate types for composing research tools.
 * Each type represents the structured output of one tool,
 * designed to be parsed from markdown and fed into the next tool.
 */

// ── Research Brief ──────────────────────────────────────────────────────────

export interface ResearchBriefData {
    topic: string;
    audience: string;
    outputType: string;
    thesis: string;
    researchQuestions: string[];
    evidenceBuckets: string[];
    sourceNotes: string[];
}

// ── Literature Scan ─────────────────────────────────────────────────────────

export interface LiteratureItem {
    source: 'semantic_scholar' | 'crossref';
    year: number;
    title: string;
    authors: string;
    citations: number;
    url: string;
}

export interface LiteratureScanData {
    query: string;
    results: LiteratureItem[];
}

// ── Evidence Matrix ─────────────────────────────────────────────────────────

export interface ClaimEvidence {
    claim: string;
    status: 'candidate support' | 'needs source' | 'contradictory' | 'weak';
    bestSourceUrl: string;
    keywordOverlap: string[];
}

export interface EvidenceMatrixData {
    claims: ClaimEvidence[];
    notes: string;
}

// ── Research Dossier ────────────────────────────────────────────────────────

export interface ResearchDossierData {
    query: string;
    contradictions: string[];
    consensus: string[];
    gaps: string[];
    synthesis: string;
}

// ── Publication Outline ─────────────────────────────────────────────────────

export interface PublicationOutlineData {
    topic: string;
    audience: string;
    format: string;
    structure: SectionOutline[];
    findings: string;
    sourceSlots: string[];
    prePublishChecks: string[];
}

export interface SectionOutline {
    title: string;
    description: string;
}

// ── Source Ledger ───────────────────────────────────────────────────────────

export interface SourceLedgerEntry {
    url: string;
    title?: string;
    fetchedAt: string;
    rating: 'strong' | 'moderate' | 'weak' | 'contradictory';
}

// ── Claim Check ─────────────────────────────────────────────────────────────

export interface ClaimCheckResult {
    claim: string;
    verdict: 'supported' | 'contradicted' | 'inconclusive' | 'error';
    sources: SourceLedgerEntry[];
    summary: string;
}

// ── Pipeline State ──────────────────────────────────────────────────────────

export type ResearchState =
    | 'briefing'       // Topic → research_brief completed
    | 'scanning'       // literature_scan in progress/complete
    | 'evidence'       // evidence_matrix built
    | 'synthesis'      // dossier + outline in progress
    | 'publication';   // outline drafted, ready for human review

// ── Research Project (for Phase 5 State Machine) ────────────────────────────

export interface ResearchProject {
    id: string;
    topic: string;
    state: ResearchState;
    brief?: ResearchBriefData;
    papers: LiteratureItem[];
    evidence: ClaimEvidence[];
    claims: ClaimCheckResult[];
    sources: SourceLedgerEntry[];
    dossier?: ResearchDossierData;
    outline?: PublicationOutlineData;
    createdAt: string;
    updatedAt: string;
}

// ── Pipeline Result ─────────────────────────────────────────────────────────

export interface PipelineResult {
    ok: boolean;
    pipeline: string;
    topic: string;
    output: string;           // Final markdown output
    steps: PipelineStep[];    // Audit trail of each step
    error?: string;
    durationMs: number;
}

export interface PipelineStep {
    tool: string;
    ok: boolean;
    durationMs: number;
    error?: string;
}
