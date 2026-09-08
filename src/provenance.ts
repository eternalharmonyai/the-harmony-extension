/**
 * Uniform provenance schema — one honest label per engine.
 *
 * Every engine the search layer can return is described by the SAME fields, so
 * the machine (and the reader) can compare engines on equal terms. This is the
 * non-editorialising alternative to a "bias warning": it states mechanisms and
 * jurisdictions, never motives, and cites the operator's own disclosures.
 *
 * Rule (from the citation format spec): describe, don't accuse. "Subject to its
 * jurisdiction's legal removal regime and ranks by an undisclosed proprietary
 * algorithm" is documented and true of every engine listed.
 */

export type RetrievalClass = 'index' | 'synthesis' | 'repository' | 'archive';

export interface EngineProvenance {
    engine: string;
    /** What the underlying index actually is (e.g. "Microsoft Bing" for DDG). */
    index: string;
    operator: string;
    jurisdiction: string;
    /** Legal removal / delisting regimes the operator is subject to. */
    removalRegime: string;
    /** How results are ranked, if disclosed. */
    rankingDisclosure: string;
    /** What the endpoint returns, which caps its citable evidence tier. */
    retrievalClass: RetrievalClass;
}

export const ENGINE_PROVENANCE: Record<string, EngineProvenance> = {
    'google-cse': {
        engine: 'google-cse',
        index: 'Google (own crawler)',
        operator: 'Google LLC',
        jurisdiction: 'US',
        removalRegime: 'US DMCA, EU right-to-be-forgotten, and government removal requests (volumes published in Google Transparency Report)',
        rankingDisclosure: 'proprietary, undisclosed',
        retrievalClass: 'index',
    },
    'ddg': {
        engine: 'ddg',
        index: 'Microsoft Bing (traditional results) plus DuckDuckBot and vertical sources',
        operator: 'DuckDuckGo Inc.',
        jurisdiction: 'US',
        removalRegime: 'inherits upstream index removal regimes',
        rankingDisclosure: 'not fully disclosed',
        retrievalClass: 'index',
    },
    'brave': {
        engine: 'brave',
        index: 'Brave (own crawler)',
        operator: 'Brave Software, Inc.',
        jurisdiction: 'US',
        removalRegime: 'US DMCA and government removal requests',
        rankingDisclosure: 'proprietary',
        retrievalClass: 'index',
    },
    'mojeek': {
        engine: 'mojeek',
        index: 'Mojeek (own crawler)',
        operator: 'Mojeek Ltd',
        jurisdiction: 'UK',
        removalRegime: 'UK/EU legal regimes',
        rankingDisclosure: 'proprietary',
        retrievalClass: 'index',
    },
    'yandex': {
        engine: 'yandex',
        index: 'Yandex (own crawler)',
        operator: 'Yandex LLC',
        jurisdiction: 'RU',
        removalRegime: 'Russian removal law',
        rankingDisclosure: 'proprietary',
        retrievalClass: 'index',
    },
    'baidu': {
        engine: 'baidu',
        index: 'Baidu (own crawler)',
        operator: 'Baidu, Inc.',
        jurisdiction: 'CN',
        removalRegime: 'PRC content regulation',
        rankingDisclosure: 'proprietary',
        retrievalClass: 'index',
    },
    'arxiv': {
        engine: 'arxiv',
        index: 'arXiv (scholarly, author-submitted)',
        operator: 'Cornell University',
        jurisdiction: 'US',
        removalRegime: 'takedown per arXiv policy',
        rankingDisclosure: 'relevance + date',
        retrievalClass: 'repository',
    },
    'crossref': {
        engine: 'crossref',
        index: 'Crossref (scholarly metadata registry)',
        operator: 'Crossref',
        jurisdiction: 'US',
        removalRegime: 'publisher-controlled metadata',
        rankingDisclosure: 'relevance',
        retrievalClass: 'repository',
    },
    'wikipedia': {
        engine: 'wikipedia',
        index: 'Wikipedia (community-edited encyclopedia)',
        operator: 'Wikimedia Foundation',
        jurisdiction: 'US',
        removalRegime: 'community policy',
        rankingDisclosure: 'relevance',
        retrievalClass: 'index',
    },
    'wayback': {
        engine: 'wayback',
        index: 'Internet Archive (web archive)',
        operator: 'Internet Archive',
        jurisdiction: 'US',
        removalRegime: 'takedown per policy',
        rankingDisclosure: 'date (chronological)',
        retrievalClass: 'archive',
    },
};

/** Provenance for an engine id, or a generic fallback for user/custom endpoints. */
export function engineProvenance(engine: string): EngineProvenance {
    return ENGINE_PROVENANCE[engine] ?? {
        engine,
        index: 'user-defined endpoint',
        operator: 'user-configured',
        jurisdiction: 'unknown',
        removalRegime: 'unknown',
        rankingDisclosure: 'unknown',
        retrievalClass: 'index',
    };
}
