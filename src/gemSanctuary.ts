/**
 * Backwards-compatibility shim forwarding legacy `gemSanctuary` imports to `prismSanctuary`.
 * New code should import from `./prismSanctuary` directly.
 */

import type {
    PrismProfileType,
    PrismKnowledgeRef,
    PrismThreadTurn,
    PrismThread,
    PrismRecord,
    PrismKnowledgeContextResult,
} from './prismSanctuary';
import {
    PRISMS_ROOT,
    LEGACY_PRISMS_ROOT,
    PRISM_SCHEMA_VERSION,
    MAX_PRISM_INSTRUCTIONS_CHARS,
    isWindowsReservedName,
    isValidPrismId,
    assertValidPrismId,
    slugifyPrismName,
    prismDirFor,
    prismFilePathFor,
    prismThreadsDirFor,
    prismKnowledgeDirFor,
    isSafeKnowledgeFileName,
    assertSafeKnowledgeFileName,
    savePrism,
    loadPrism,
    listPrisms,
    resolveCanonicalThreadId,
    savePrismThread,
    listPrismThreads,
    DEFAULT_PRISM_KNOWLEDGE_MAX_FILE_CHARS,
    DEFAULT_PRISM_KNOWLEDGE_MAX_TOTAL_CHARS,
    MAX_PRISM_KNOWLEDGE_WRITE_BYTES,
    savePrismKnowledgeFile,
    readPrismKnowledgeContext,
    importPrismsBundle,
    buildPrismBundleTemplate,
} from './prismSanctuary';

export {
    PRISMS_ROOT,
    LEGACY_PRISMS_ROOT,
    PRISM_SCHEMA_VERSION,
    MAX_PRISM_INSTRUCTIONS_CHARS,
    isWindowsReservedName,
    isSafeKnowledgeFileName,
    assertSafeKnowledgeFileName,
    resolveCanonicalThreadId,
    buildPrismBundleTemplate,
};

export const GEMS_ROOT = PRISMS_ROOT;
export const LEGACY_GEMS_ROOT = LEGACY_PRISMS_ROOT;
export const GEM_SCHEMA_VERSION = PRISM_SCHEMA_VERSION;
export const MAX_GEM_INSTRUCTIONS_CHARS = MAX_PRISM_INSTRUCTIONS_CHARS;
export type GemAccountType = PrismProfileType;
export type GemKnowledgeRef = PrismKnowledgeRef;
export type GemThreadTurn = PrismThreadTurn;
export type GemThread = PrismThread & { gemId?: string };
export type GemRecord = PrismRecord & { gemId?: string };
export type GemKnowledgeContextResult = PrismKnowledgeContextResult;

export interface GemImportReport {
    importedGems: Array<PrismRecord & { gemId: string }>;
    importedThreads: number;
    skipped: number;
    warnings: string[];
}

export const isValidGemId = isValidPrismId;
export const assertValidGemId = assertValidPrismId;
export const slugifyGemName = slugifyPrismName;
export const gemDirFor = prismDirFor;
export const gemFilePathFor = prismFilePathFor;
export const gemThreadsDirFor = prismThreadsDirFor;
export const gemKnowledgeDirFor = prismKnowledgeDirFor;
export const isSafeGemFileName = isSafeKnowledgeFileName;
export const assertSafeGemFileName = assertSafeKnowledgeFileName;
export const resolveCanonicalGemThreadId = resolveCanonicalThreadId;
export const buildGemBundleTemplate = buildPrismBundleTemplate;
export const DEFAULT_GEM_KNOWLEDGE_MAX_FILE_CHARS = DEFAULT_PRISM_KNOWLEDGE_MAX_FILE_CHARS;
export const DEFAULT_GEM_KNOWLEDGE_MAX_TOTAL_CHARS = DEFAULT_PRISM_KNOWLEDGE_MAX_TOTAL_CHARS;
export const MAX_GEM_KNOWLEDGE_WRITE_BYTES = MAX_PRISM_KNOWLEDGE_WRITE_BYTES;

export function saveGem(
    workspaceRoot: string,
    input: Partial<PrismRecord> & { name: string; systemInstructions: string; prismId?: string; gemId?: string }
): PrismRecord & { gemId: string } {
    const saved = savePrism(workspaceRoot, input);
    return { ...saved, gemId: saved.prismId };
}

export function loadGem(workspaceRoot: string, id: string): (PrismRecord & { gemId: string }) | null {
    const loaded = loadPrism(workspaceRoot, id);
    return loaded ? { ...loaded, gemId: loaded.prismId } : null;
}

export function listGems(workspaceRoot: string): { gems: Array<PrismRecord & { gemId: string }>; warnings: string[] } {
    const res = listPrisms(workspaceRoot);
    return {
        gems: res.prisms.map((p) => ({ ...p, gemId: p.prismId })),
        warnings: res.warnings,
    };
}

export function saveGemThread(
    workspaceRoot: string,
    id: string,
    thread: { threadId?: string; title?: string; turns: Array<{ role?: string; text?: string; content?: string; ts?: string }> }
): PrismThread & { gemId: string } {
    const saved = savePrismThread(workspaceRoot, id, thread);
    return { ...saved, gemId: saved.prismId };
}

export function listGemThreads(workspaceRoot: string, id: string): Array<PrismThread & { gemId: string }> {
    return listPrismThreads(workspaceRoot, id).map((t) => ({ ...t, gemId: t.prismId }));
}

export const saveGemKnowledgeFile = savePrismKnowledgeFile;
export const readGemKnowledgeContext = readPrismKnowledgeContext;

export function importGemsBundle(
    workspaceRoot: string,
    bundle: unknown,
    defaultAccount: PrismProfileType = 'custom'
): GemImportReport {
    const res = importPrismsBundle(workspaceRoot, bundle, defaultAccount);
    return {
        importedGems: res.importedPrisms.map((p) => ({ ...p, gemId: p.prismId })),
        importedThreads: res.importedThreads,
        skipped: res.skipped,
        warnings: res.warnings,
    };
}
