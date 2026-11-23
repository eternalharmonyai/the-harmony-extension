/**
 * Prism Sanctuary — Local Specialist Rooms, Multi-Profile Importer, and Strict Context Isolation.
 *
 * Why this module exists
 * ----------------------
 * Standalone Prisms follow three neurodivergent-focused design principles that a flat
 * slash-command stream lacks:
 *   1. Visual separation (you always know WHICH specialist lens is active).
 *   2. Dedicated sidebar/header anchors (one click to enter a Prism room).
 *   3. Strict context isolation (a Prism's instructions, knowledge files, and
 *      conversation threads live in `.harmony/prisms/<prismId>/` and stay separate
 *      from the general chat stream).
 *
 * Supports importing local Prism JSON bundles across multiple workspace profiles
 * (`enterprise`, `regular-1`, `regular-2`, `custom`) with cross-profile slug
 * disambiguation on import, instruction length bounds, and provenance tagging.
 *
 * Also supports transparent read fallback and asset carry-forward for legacy
 * `.harmony/gems/<id>/` directories during workspace upgrades.
 *
 * No `vscode` import so gate scripts and CLI helpers can execute the compiled module directly.
 */

import * as fs from 'fs';
import * as path from 'path';

export const PRISMS_ROOT = '.harmony/prisms';
export const LEGACY_PRISMS_ROOT = '.harmony/gems';
export const PRISM_SCHEMA_VERSION = 2;
export const MAX_PRISM_INSTRUCTIONS_CHARS = 64000;

const PRISM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export type PrismProfileType = 'enterprise' | 'regular-1' | 'regular-2' | 'custom';

export interface PrismKnowledgeRef {
    name: string;
    mimeType?: string;
    externalRefId?: string;
    localPath?: string;
}

export interface PrismThreadTurn {
    role: 'user' | 'assistant';
    text: string;
    ts: string;
}

export interface PrismThread {
    prismId: string;
    threadId: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    turns: PrismThreadTurn[];
}

export interface PrismRecord {
    prismId: string;
    name: string;
    description?: string;
    /** Custom system instructions for this Prism room. */
    systemInstructions: string;
    /** Optional conversation starters. */
    starterPrompts?: string[];
    /** Which workspace profile this Prism belongs to (enterprise, regular-1, regular-2, custom). */
    account: PrismProfileType;
    /** Optional profile label (e.g. team or project name). */
    accountLabel?: string;
    /** Knowledge files attached to this Prism. */
    knowledgeFiles: PrismKnowledgeRef[];
    /** Optional external identifier for idempotent re-imports. */
    externalId?: string;
    /** Provenance flag set when imported from an external JSON bundle. */
    imported?: boolean;
    importedAt?: string;
    createdAt: string;
    updatedAt: string;
    schemaVersion: number;
}

/** Deterministic 32-bit FNV-1a hash rendered as 6 base36 chars. */
function fnv1aShort(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36).padStart(6, '0').slice(0, 6);
}

function firstNonEmpty(...values: unknown[]): string {
    for (const v of values) {
        if (typeof v === 'string' && v.trim().length > 0) {
            return v.trim();
        }
    }
    return '';
}

export function isWindowsReservedName(name: string): boolean {
    if (typeof name !== 'string') return true;
    const trimmed = name.trim();
    if (WINDOWS_RESERVED_BASENAME.test(trimmed)) return true;
    const stemBeforeDot = trimmed.split('.')[0].trim();
    return WINDOWS_RESERVED_BASENAME.test(stemBeforeDot);
}

function assertNoSymlinkChain(workspaceRoot: string, targetPath: string): void {
    const rootResolved = path.resolve(workspaceRoot);
    const targetResolved = path.resolve(targetPath);
    const rel = path.relative(rootResolved, targetResolved);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
        throw new Error(`refused: path ${JSON.stringify(targetPath)} resolves outside workspace root`);
    }
    if (!rel) return;
    const parts = rel.split(path.sep).filter(Boolean);
    let current = rootResolved;
    for (const part of parts) {
        current = path.join(current, part);
        if (fs.existsSync(current)) {
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink()) {
                throw new Error(`refused: symbolic link encountered at ${current}`);
            }
        }
    }
}

function writeJsonAtomically(workspaceRoot: string, filePath: string, payload: unknown): void {
    assertNoSymlinkChain(workspaceRoot, filePath);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    assertNoSymlinkChain(workspaceRoot, filePath);
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
}

export function isValidPrismId(prismId: string): boolean {
    if (typeof prismId !== 'string') return false;
    if (!PRISM_ID_PATTERN.test(prismId)) return false;
    if (isWindowsReservedName(prismId)) return false;
    return true;
}

export function assertValidPrismId(prismId: string): void {
    if (!isValidPrismId(prismId)) {
        throw new Error(
            `invalid prism id ${JSON.stringify(prismId)}: must match ${PRISM_ID_PATTERN} ` +
            `and must not be a Windows reserved device name. Refused rather than sanitised.`
        );
    }
}

/** Deterministic slug generator for human Prism names (e.g. "Alpha — Specialist" -> "alpha-specialist"). */
export function slugifyPrismName(name: string, fallback = 'prism'): string {
    const raw = String(name ?? '').trim();
    const cleaned = raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    const safePrefix = /^[a-z0-9]+$/.test(fallback) ? fallback : 'prism';
    let candidate: string;
    if (!cleaned || cleaned.length < 2 || isWindowsReservedName(cleaned)) {
        candidate = `${safePrefix}-${fnv1aShort(raw || safePrefix)}`;
    } else if (cleaned.length > 50) {
        const prefix = cleaned.slice(0, 48).replace(/-+$/, '');
        candidate = `${prefix}-${fnv1aShort(raw)}`;
    } else {
        candidate = cleaned;
    }
    assertValidPrismId(candidate);
    return candidate;
}

function resolveContainedDir(workspaceRoot: string, storeRoot: string, prismId: string): string {
    assertValidPrismId(prismId);
    const base = path.resolve(workspaceRoot, storeRoot);
    const target = path.resolve(base, prismId);
    const withSep = base.endsWith(path.sep) ? base : base + path.sep;
    if (target !== base && !target.startsWith(withSep)) {
        throw new Error(`refused: prism id ${JSON.stringify(prismId)} resolves outside ${storeRoot}`);
    }
    return target;
}

export function prismDirFor(workspaceRoot: string, prismId: string): string {
    return resolveContainedDir(workspaceRoot, PRISMS_ROOT, prismId);
}

function legacyPrismDirFor(workspaceRoot: string, prismId: string): string {
    return resolveContainedDir(workspaceRoot, LEGACY_PRISMS_ROOT, prismId);
}

/** Resolve active directory on disk: prefers `.harmony/prisms/<id>`, falls back to legacy `.harmony/gems/<id>` if present. */
function activePrismDirForRead(workspaceRoot: string, prismId: string): { dir: string; rootLabel: string } {
    const primary = prismDirFor(workspaceRoot, prismId);
    if (fs.existsSync(primary)) {
        return { dir: primary, rootLabel: PRISMS_ROOT };
    }
    const legacy = legacyPrismDirFor(workspaceRoot, prismId);
    if (fs.existsSync(legacy)) {
        return { dir: legacy, rootLabel: LEGACY_PRISMS_ROOT };
    }
    return { dir: primary, rootLabel: PRISMS_ROOT };
}

export function prismFilePathFor(workspaceRoot: string, prismId: string): string {
    return path.join(prismDirFor(workspaceRoot, prismId), 'prism.json');
}

export function prismThreadsDirFor(workspaceRoot: string, prismId: string): string {
    return path.join(prismDirFor(workspaceRoot, prismId), 'threads');
}

export function prismKnowledgeDirFor(workspaceRoot: string, prismId: string): string {
    return path.join(prismDirFor(workspaceRoot, prismId), 'knowledge');
}

const SAFE_KNOWLEDGE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}$/;

export function isSafeKnowledgeFileName(name: string): boolean {
    if (typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (!SAFE_KNOWLEDGE_FILENAME.test(trimmed)) return false;
    if (/[. ]$/.test(trimmed)) return false;
    if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) return false;
    if (isWindowsReservedName(trimmed)) return false;
    return true;
}

export function assertSafeKnowledgeFileName(name: string): void {
    if (!isSafeKnowledgeFileName(name)) {
        throw new Error(
            `invalid knowledge file name ${JSON.stringify(name)}: must be a flat filename ` +
            `without path separators, '..', trailing dots, or Windows reserved device names. Refused rather than sanitised.`
        );
    }
}

function sanitizeKnowledgeRefs(prismId: string, rawRefs: unknown): { refs: PrismKnowledgeRef[]; rejected: string[] } {
    if (!Array.isArray(rawRefs)) return { refs: [], rejected: [] };
    const byLower = new Map<string, PrismKnowledgeRef>();
    const rejected: string[] = [];
    const expectedPrefix = `${PRISMS_ROOT}/${prismId}/knowledge/`;
    const legacyPrefix = `${LEGACY_PRISMS_ROOT}/${prismId}/knowledge/`;

    for (const item of rawRefs) {
        const rawObj = typeof item === 'string' ? { name: item } : item;
        if (!rawObj || typeof rawObj !== 'object' || typeof rawObj.name !== 'string') continue;
        const cleanName = rawObj.name.trim();
        if (!isSafeKnowledgeFileName(cleanName)) {
            rejected.push(cleanName || '(empty)');
            continue;
        }
        const safeLocalPath = `${expectedPrefix}${cleanName}`;
        const legacyLocalPath = `${legacyPrefix}${cleanName}`;
        if (typeof rawObj.localPath === 'string' && rawObj.localPath.trim()) {
            const normalizedLocal = rawObj.localPath.trim().replace(/\\/g, '/');
            if (normalizedLocal !== safeLocalPath && normalizedLocal !== legacyLocalPath) {
                rejected.push(`${cleanName} (untrusted localPath ${rawObj.localPath})`);
                continue;
            }
        }
        const extRef = rawObj.externalRefId ?? rawObj.driveId;
        byLower.set(cleanName.toLowerCase(), {
            name: cleanName,
            ...(rawObj.mimeType ? { mimeType: String(rawObj.mimeType).trim() } : {}),
            ...(extRef ? { externalRefId: String(extRef).trim() } : {}),
            ...(rawObj.localPath ? { localPath: safeLocalPath } : {}),
        });
    }

    const refs = Array.from(byLower.values()).sort((a, b) => a.name.localeCompare(b.name));
    return { refs, rejected };
}

/** Copy regular non-symlink legacy threads/knowledge files when migrating a legacy `.harmony/gems/<id>` entry on save. */
function copyLegacySubdirFilesIfPresent(workspaceRoot: string, prismId: string): void {
    const legacyBase = legacyPrismDirFor(workspaceRoot, prismId);
    if (!fs.existsSync(legacyBase)) return;
    try {
        assertNoSymlinkChain(workspaceRoot, legacyBase);
    } catch {
        return;
    }
    for (const sub of ['threads', 'knowledge'] as const) {
        const srcDir = path.join(legacyBase, sub);
        const dstDir = sub === 'threads' ? prismThreadsDirFor(workspaceRoot, prismId) : prismKnowledgeDirFor(workspaceRoot, prismId);
        try {
            if (!fs.existsSync(srcDir) || fs.lstatSync(srcDir).isSymbolicLink()) continue;
            fs.mkdirSync(dstDir, { recursive: true });
            assertNoSymlinkChain(workspaceRoot, dstDir);
            for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
                if (!entry.isFile() || entry.isSymbolicLink()) continue;
                if (sub === 'knowledge' && !isSafeKnowledgeFileName(entry.name)) continue;
                const srcFile = path.join(srcDir, entry.name);
                const dstFile = path.join(dstDir, entry.name);
                if (fs.lstatSync(srcFile).isSymbolicLink()) continue;
                if (!fs.existsSync(dstFile)) {
                    fs.copyFileSync(srcFile, dstFile);
                }
            }
        } catch { /* best-effort carry-forward */ }
    }
}

export function savePrism(
    workspaceRoot: string,
    input: Partial<PrismRecord> & { name: string; systemInstructions: string; prismId?: string; gemId?: string }
): PrismRecord {
    const rawId = input.prismId ?? input.gemId;
    const prismId = rawId ? rawId.trim() : slugifyPrismName(input.name);
    assertValidPrismId(prismId);
    const existing = loadPrism(workspaceRoot, prismId);
    const file = prismFilePathFor(workspaceRoot, prismId);

    const now = new Date().toISOString();
    const validProfiles: PrismProfileType[] = ['enterprise', 'regular-1', 'regular-2', 'custom'];
    const account: PrismProfileType = input.account && validProfiles.includes(input.account)
        ? input.account
        : (existing?.account ?? 'custom');

    const { refs: knowledgeFiles } = Array.isArray(input.knowledgeFiles)
        ? sanitizeKnowledgeRefs(prismId, input.knowledgeFiles)
        : { refs: existing?.knowledgeFiles ?? [] };

    const boundedInstructions = String(input.systemInstructions ?? '').trim().slice(0, MAX_PRISM_INSTRUCTIONS_CHARS);

    const record: PrismRecord = {
        prismId,
        name: firstNonEmpty(input.name, existing?.name, prismId),
        description: typeof input.description === 'string' ? input.description.trim() : existing?.description,
        systemInstructions: boundedInstructions,
        starterPrompts: Array.isArray(input.starterPrompts)
            ? input.starterPrompts.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim())
            : (existing?.starterPrompts ?? []),
        account,
        accountLabel: typeof input.accountLabel === 'string' ? input.accountLabel.trim() : existing?.accountLabel,
        knowledgeFiles,
        externalId: typeof input.externalId === 'string' && input.externalId.trim() ? input.externalId.trim() : existing?.externalId,
        ...(input.imported !== undefined ? { imported: Boolean(input.imported) } : (existing?.imported !== undefined ? { imported: existing.imported } : {})),
        ...(input.importedAt ? { importedAt: input.importedAt } : (existing?.importedAt ? { importedAt: existing.importedAt } : {})),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        schemaVersion: PRISM_SCHEMA_VERSION,
    };

    assertNoSymlinkChain(workspaceRoot, file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(prismThreadsDirFor(workspaceRoot, prismId), { recursive: true });
    fs.mkdirSync(prismKnowledgeDirFor(workspaceRoot, prismId), { recursive: true });
    copyLegacySubdirFilesIfPresent(workspaceRoot, prismId);
    writeJsonAtomically(workspaceRoot, file, record);
    return record;
}

export function loadPrism(workspaceRoot: string, prismId: string): PrismRecord | null {
    if (!isValidPrismId(prismId)) return null;
    const candidates = [
        path.join(prismDirFor(workspaceRoot, prismId), 'prism.json'),
        path.join(prismDirFor(workspaceRoot, prismId), 'gem.json'),
        path.join(legacyPrismDirFor(workspaceRoot, prismId), 'prism.json'),
        path.join(legacyPrismDirFor(workspaceRoot, prismId), 'gem.json'),
    ];
    for (const file of candidates) {
        try {
            if (!fs.existsSync(file)) continue;
            assertNoSymlinkChain(workspaceRoot, file);
            const stat = fs.lstatSync(file);
            if (stat.isSymbolicLink() || !stat.isFile()) continue;
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            const recordedId = parsed?.prismId ?? parsed?.gemId;
            if (!parsed || typeof parsed !== 'object' || recordedId !== prismId) continue;
            if (typeof parsed.name !== 'string' || !parsed.name.trim()) continue;
            if (typeof parsed.systemInstructions !== 'string') continue;
            const { refs } = sanitizeKnowledgeRefs(prismId, parsed.knowledgeFiles);
            return {
                ...parsed,
                prismId,
                name: parsed.name.trim(),
                systemInstructions: parsed.systemInstructions.slice(0, MAX_PRISM_INSTRUCTIONS_CHARS),
                knowledgeFiles: refs,
                account: ['enterprise', 'regular-1', 'regular-2', 'custom'].includes(parsed.account) ? parsed.account : 'custom',
                createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date(0).toISOString(),
                updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
                schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : PRISM_SCHEMA_VERSION,
            } as PrismRecord;
        } catch {
            continue;
        }
    }
    return null;
}

export function listPrisms(workspaceRoot: string): { prisms: PrismRecord[]; warnings: string[] } {
    const prismsById = new Map<string, PrismRecord>();
    const warnings: string[] = [];
    for (const rootRel of [PRISMS_ROOT, LEGACY_PRISMS_ROOT]) {
        const base = path.resolve(workspaceRoot, rootRel);
        try {
            if (!fs.existsSync(base)) continue;
            assertNoSymlinkChain(workspaceRoot, base);
            const entries = fs.readdirSync(base, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
                if (!isValidPrismId(entry.name)) {
                    warnings.push(`Skipped directory with invalid prismId: ${entry.name}`);
                    continue;
                }
                if (prismsById.has(entry.name)) continue;
                const loaded = loadPrism(workspaceRoot, entry.name);
                if (loaded) {
                    prismsById.set(entry.name, loaded);
                } else {
                    warnings.push(`Could not read valid prism.json inside ${entry.name}`);
                }
            }
        } catch (err: any) {
            warnings.push(`Error scanning ${rootRel}: ${err?.message ?? String(err)}`);
        }
    }
    const prisms = Array.from(prismsById.values()).sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
    return { prisms, warnings };
}

let canonicalThreadSeq = 0;

/** Canonicalize a thread ID (`a/b` vs `a-b` produce distinct IDs via hash suffix when non-slug chars are present). */
export function resolveCanonicalThreadId(rawInput?: string): string {
    const raw = String(rawInput ?? '').trim();
    if (!raw) {
        canonicalThreadSeq = (canonicalThreadSeq + 1) % 1679616;
        return `t-${Date.now().toString(36)}-${canonicalThreadSeq.toString(36)}`;
    }
    if (/^[a-z0-9][a-z0-9-]{1,50}$/.test(raw) && !isWindowsReservedName(raw)) {
        return raw;
    }
    const base = raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 42);
    const prefix = base.length >= 2 && !isWindowsReservedName(base) ? base : 'thread';
    return `${prefix}-${fnv1aShort(raw)}`;
}

export function savePrismThread(
    workspaceRoot: string,
    prismId: string,
    thread: { threadId?: string; title?: string; turns: Array<{ role?: string; text?: string; content?: string; ts?: string }> }
): PrismThread {
    assertValidPrismId(prismId);
    const prism = loadPrism(workspaceRoot, prismId);
    if (!prism) {
        throw new Error(`refused: cannot save thread for nonexistent Prism ${JSON.stringify(prismId)}`);
    }
    const threadsDir = prismThreadsDirFor(workspaceRoot, prismId);
    fs.mkdirSync(threadsDir, { recursive: true });

    const threadId = resolveCanonicalThreadId(thread.threadId);
    const now = new Date().toISOString();
    const turns: PrismThreadTurn[] = [];
    for (const rawTurn of Array.isArray(thread.turns) ? thread.turns : []) {
        if (!rawTurn || typeof rawTurn !== 'object') continue;
        const text = firstNonEmpty(rawTurn.text, rawTurn.content);
        if (!text) continue;
        turns.push({
            role: rawTurn.role === 'assistant' ? 'assistant' : 'user',
            text,
            ts: typeof rawTurn.ts === 'string' && rawTurn.ts ? rawTurn.ts : now,
        });
    }

    const file = path.join(threadsDir, `${threadId}.json`);
    let existing: PrismThread | null = null;
    try {
        if (fs.existsSync(file)) {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            const owner = parsed?.prismId ?? parsed?.gemId;
            if (parsed && (!owner || owner === prismId)) {
                existing = parsed;
            }
        }
    } catch {
        existing = null;
    }

    const saved: PrismThread = {
        prismId,
        threadId,
        title: firstNonEmpty(thread.title, existing?.title, turns[0]?.text.slice(0, 60), 'Prism Conversation'),
        createdAt: typeof existing?.createdAt === 'string' ? existing.createdAt : now,
        updatedAt: now,
        turns,
    };
    writeJsonAtomically(workspaceRoot, file, saved);
    return saved;
}

export function listPrismThreads(workspaceRoot: string, prismId: string): PrismThread[] {
    if (!isValidPrismId(prismId)) return [];
    const byId = new Map<string, PrismThread>();
    const candidateDirs = [
        prismThreadsDirFor(workspaceRoot, prismId),
        path.join(legacyPrismDirFor(workspaceRoot, prismId), 'threads'),
    ];
    for (const threadsDir of candidateDirs) {
        try {
            if (!fs.existsSync(threadsDir)) continue;
            const files = fs.readdirSync(threadsDir).filter((f) => f.endsWith('.json'));
            for (const f of files) {
                try {
                    const fullPath = path.join(threadsDir, f);
                    const stat = fs.lstatSync(fullPath);
                    if (stat.isSymbolicLink() || !stat.isFile()) continue;
                    const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                    if (!parsed || typeof parsed.threadId !== 'string' || !Array.isArray(parsed.turns)) continue;
                    const owner = parsed.prismId ?? parsed.gemId;
                    if (owner && owner !== prismId) continue;
                    if (byId.has(parsed.threadId)) continue;
                    byId.set(parsed.threadId, {
                        prismId,
                        threadId: parsed.threadId,
                        title: typeof parsed.title === 'string' ? parsed.title : 'Prism Conversation',
                        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date(0).toISOString(),
                        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
                        turns: parsed.turns,
                    });
                } catch { /* skip corrupt thread file */ }
            }
        } catch { /* ignore */ }
    }
    return Array.from(byId.values()).sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
}

export const DEFAULT_PRISM_KNOWLEDGE_MAX_FILE_CHARS = 8000;
export const DEFAULT_PRISM_KNOWLEDGE_MAX_TOTAL_CHARS = 24000;
export const MAX_PRISM_KNOWLEDGE_WRITE_BYTES = 10 * 1024 * 1024; // 10 MB hard cap per knowledge file

export interface PrismKnowledgeContextResult {
    text: string;
    includedFiles: string[];
    binaryFiles: string[];
    truncatedFiles: string[];
    missingFiles: string[];
}

/**
 * Save a text or binary knowledge file into `.harmony/prisms/<prismId>/knowledge/<name>`
 * and update the Prism's `knowledgeFiles` manifest in `prism.json`.
 */
export function savePrismKnowledgeFile(
    workspaceRoot: string,
    prismId: string,
    file: { name: string; content: string | Buffer; mimeType?: string; externalRefId?: string }
): PrismKnowledgeRef {
    assertValidPrismId(prismId);
    const cleanName = String(file?.name ?? '').trim();
    assertSafeKnowledgeFileName(cleanName);
    const prism = loadPrism(workspaceRoot, prismId);
    if (!prism) {
        throw new Error(`refused: Prism ${JSON.stringify(prismId)} does not exist in ${PRISMS_ROOT}`);
    }
    const kDir = prismKnowledgeDirFor(workspaceRoot, prismId);
    fs.mkdirSync(kDir, { recursive: true });
    const kDirStat = fs.lstatSync(kDir);
    if (kDirStat.isSymbolicLink()) {
        throw new Error(`refused: knowledge directory ${kDir} is a symbolic link`);
    }
    const targetPath = path.resolve(kDir, cleanName);
    const withSep = kDir.endsWith(path.sep) ? kDir : kDir + path.sep;
    if (!targetPath.startsWith(withSep)) {
        throw new Error(`refused: knowledge file ${JSON.stringify(cleanName)} resolves outside ${kDir}`);
    }
    if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isSymbolicLink()) {
        throw new Error(`refused: target knowledge file ${JSON.stringify(cleanName)} is a symbolic link`);
    }
    const buf = Buffer.isBuffer(file.content)
        ? file.content
        : Buffer.from(String(file.content ?? ''), 'utf8');
    if (buf.byteLength > MAX_PRISM_KNOWLEDGE_WRITE_BYTES) {
        throw new Error(
            `refused: knowledge file ${JSON.stringify(cleanName)} is ${buf.byteLength} bytes ` +
            `(exceeds ${MAX_PRISM_KNOWLEDGE_WRITE_BYTES} byte limit)`
        );
    }
    fs.writeFileSync(targetPath, buf);
    const relLocalPath = `${PRISMS_ROOT}/${prismId}/knowledge/${cleanName}`;
    const ref: PrismKnowledgeRef = {
        name: cleanName,
        localPath: relLocalPath,
        ...(file.mimeType ? { mimeType: String(file.mimeType).trim() } : {}),
        ...(file.externalRefId ? { externalRefId: String(file.externalRefId).trim() } : {}),
    };
    const updatedFiles = prism.knowledgeFiles.filter((k) => k.name.toLowerCase() !== cleanName.toLowerCase());
    updatedFiles.push(ref);
    updatedFiles.sort((a, b) => a.name.localeCompare(b.name));
    savePrism(workspaceRoot, { ...prism, knowledgeFiles: updatedFiles });
    return ref;
}

/**
 * Read bounded, Prism-scoped knowledge context from `.harmony/prisms/<prismId>/knowledge/`
 * (with transparent read fallback to legacy `.harmony/gems/<prismId>/knowledge/`).
 *
 * - Uses bounded `fs.openSync` / `fs.readSync` so large files are never read wholly into memory.
 * - Refuses symlinks via `fs.lstatSync`.
 * - Detects binary files (by null bytes) and lists them by path without injecting raw bytes.
 * - Rule #6 (No silent truncation): discloses `includedFiles`, `binaryFiles`, `truncatedFiles`,
 *   and `missingFiles`.
 */
export function readPrismKnowledgeContext(
    workspaceRoot: string,
    prismId: string,
    options: { maxCharsPerFile?: number; maxTotalChars?: number } = {}
): PrismKnowledgeContextResult {
    assertValidPrismId(prismId);
    const prism = loadPrism(workspaceRoot, prismId);
    if (!prism) {
        return { text: '', includedFiles: [], binaryFiles: [], truncatedFiles: [], missingFiles: [] };
    }
    const maxPerFile = Math.max(256, options.maxCharsPerFile ?? DEFAULT_PRISM_KNOWLEDGE_MAX_FILE_CHARS);
    const maxTotal = Math.max(maxPerFile, options.maxTotalChars ?? DEFAULT_PRISM_KNOWLEDGE_MAX_TOTAL_CHARS);
    const active = activePrismDirForRead(workspaceRoot, prismId);
    const primaryKDir = prismKnowledgeDirFor(workspaceRoot, prismId);
    const legacyKDir = path.join(legacyPrismDirFor(workspaceRoot, prismId), 'knowledge');

    const byLower = new Map<string, string>();
    const safePrismFiles = Array.isArray(prism.knowledgeFiles) ? prism.knowledgeFiles : [];
    for (const k of safePrismFiles) {
        if (k && typeof k.name === 'string' && isSafeKnowledgeFileName(k.name)) {
            byLower.set(k.name.trim().toLowerCase(), k.name.trim());
        }
    }
    for (const dir of [primaryKDir, legacyKDir]) {
        try {
            if (fs.existsSync(dir) && !fs.lstatSync(dir).isSymbolicLink()) {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (entry.isFile() && !entry.isSymbolicLink() && isSafeKnowledgeFileName(entry.name)) {
                        byLower.set(entry.name.toLowerCase(), entry.name);
                    }
                }
            }
        } catch { /* ignore */ }
    }

    const allCandidateNames = Array.from(byLower.values()).sort((a, b) => a.localeCompare(b));
    const includedFiles: string[] = [];
    const binaryFiles: string[] = [];
    const truncatedFiles: string[] = [];
    const missingFiles: string[] = [];
    const sections: string[] = [];
    let usedChars = 0;

    for (const name of allCandidateNames) {
        if (!isSafeKnowledgeFileName(name)) {
            missingFiles.push(name);
            continue;
        }
        const primaryPath = path.join(primaryKDir, name);
        const legacyPath = path.join(legacyKDir, name);
        const fullPath = fs.existsSync(primaryPath) ? primaryPath : legacyPath;
        const activeRootRel = fullPath === primaryPath ? PRISMS_ROOT : LEGACY_PRISMS_ROOT;
        let stat: fs.Stats;
        try {
            if (!fs.existsSync(fullPath)) {
                missingFiles.push(name);
                continue;
            }
            stat = fs.lstatSync(fullPath);
            if (stat.isSymbolicLink() || !stat.isFile()) {
                missingFiles.push(name);
                continue;
            }
        } catch {
            missingFiles.push(name);
            continue;
        }

        const remaining = maxTotal - usedChars;
        if (remaining <= 0) {
            truncatedFiles.push(name);
            continue;
        }

        const capChars = Math.min(maxPerFile, remaining);
        const maxBytesToRead = Math.min(stat.size, capChars * 4 + 4);
        const buf = Buffer.alloc(maxBytesToRead);
        let bytesRead = 0;
        let fd: number | null = null;
        try {
            fd = fs.openSync(fullPath, 'r');
            bytesRead = fs.readSync(fd, buf, 0, maxBytesToRead, 0);
        } catch {
            missingFiles.push(name);
            continue;
        } finally {
            if (fd !== null) {
                try { fs.closeSync(fd); } catch { /* ignore */ }
            }
        }

        const sample = buf.subarray(0, bytesRead);
        const hasNullByte = sample.includes(0);
        if (hasNullByte) {
            binaryFiles.push(name);
            includedFiles.push(name);
            sections.push(`--- KNOWLEDGE ASSET (binary): ${name} (${stat.size} bytes on disk at ${activeRootRel}/${prismId}/knowledge/${name}) ---`);
            continue;
        }

        const decoded = sample.toString('utf8');
        const wasTruncatedByByteWindow = stat.size > bytesRead;
        const wasTruncatedByCharCap = decoded.length > capChars;
        const slice = wasTruncatedByCharCap ? decoded.slice(0, capChars) : decoded;
        if (wasTruncatedByByteWindow || wasTruncatedByCharCap) {
            truncatedFiles.push(name);
        }
        includedFiles.push(name);
        usedChars += slice.length;
        const sizeLabel = (wasTruncatedByByteWindow || wasTruncatedByCharCap)
            ? `truncated ${slice.length} chars of ${stat.size} bytes`
            : `${slice.length} chars`;
        sections.push(`--- KNOWLEDGE FILE: ${name} (${sizeLabel}) ---\n${slice}`);
    }

    const disclosures: string[] = [];
    if (includedFiles.length > 0) {
        disclosures.push(`Included local knowledge files (${includedFiles.length}): ${includedFiles.join(', ')}`);
    }
    if (binaryFiles.length > 0) {
        disclosures.push(`[Disclosure: ${binaryFiles.length} binary knowledge asset(s) referenced by path without raw byte injection: ${binaryFiles.join(', ')}]`);
    }
    if (truncatedFiles.length > 0) {
        disclosures.push(`[Disclosure: ${truncatedFiles.length} knowledge file(s) truncated/omitted to fit ${maxTotal}-char budget: ${truncatedFiles.join(', ')}]`);
    }
    if (missingFiles.length > 0) {
        disclosures.push(`[Disclosure: ${missingFiles.length} declared knowledge file(s) not yet placed in ${active.rootLabel}/${prismId}/knowledge/: ${missingFiles.join(', ')}]`);
    }

    const body = sections.length > 0 ? `\n${sections.join('\n\n')}` : '';
    const text = disclosures.length > 0 ? `${disclosures.join('\n')}${body}` : '';
    return { text, includedFiles, binaryFiles, truncatedFiles, missingFiles };
}

export interface PrismImportReport {
    importedPrisms: PrismRecord[];
    importedThreads: number;
    skipped: number;
    warnings: string[];
}

/**
 * Import a local JSON bundle of Prisms across workspace profiles
 * (`enterprise`, `regular-1`, `regular-2`, `custom`).
 *
 * Preserves cross-profile isolation: if a Prism with the same name already exists
 * under a DIFFERENT profile (or different externalId), its slug is automatically
 * disambiguated with the profile prefix (`<profile>-<slug>`) so neither Prism's
 * instructions, knowledge files, or threads overwrite each other.
 */
export function importPrismsBundle(
    workspaceRoot: string,
    bundle: unknown,
    defaultAccount: PrismProfileType = 'custom'
): PrismImportReport {
    const importedPrisms: PrismRecord[] = [];
    let importedThreads = 0;
    let skipped = 0;
    const warnings: string[] = [];

    if (!bundle || typeof bundle !== 'object') {
        return { importedPrisms: [], importedThreads: 0, skipped: 1, warnings: ['Bundle is empty or not an object.'] };
    }

    const rootObj = bundle as Record<string, any>;
    const bundleAccount: PrismProfileType =
        rootObj.account === 'enterprise' || rootObj.account === 'regular-1' || rootObj.account === 'regular-2'
            ? rootObj.account
            : (rootObj.profile === 'enterprise' || rootObj.profile === 'regular-1' || rootObj.profile === 'regular-2'
                ? rootObj.profile
                : defaultAccount);
    const rawItems: any[] = Array.isArray(bundle)
        ? bundle
        : Array.isArray(rootObj.prisms)
            ? rootObj.prisms
            : Array.isArray(rootObj.gems)
                ? rootObj.gems
                : Array.isArray(rootObj.items)
                    ? rootObj.items
                    : [rootObj];

    const importedAt = new Date().toISOString();

    for (const raw of rawItems) {
        try {
            if (!raw || typeof raw !== 'object') {
                skipped++;
                continue;
            }
            const name = firstNonEmpty(raw.name, raw.title, raw.prismName, raw.gemName);
            const rawInstructions = firstNonEmpty(
                raw.systemInstructions,
                raw.instructions,
                raw.prompt,
                raw.systemPrompt,
                raw.description
            );
            if (!name || !rawInstructions) {
                skipped++;
                warnings.push(`Skipped entry missing name or instructions (${name || 'unnamed'}).`);
                continue;
            }
            let instructions = rawInstructions;
            if (rawInstructions.length > MAX_PRISM_INSTRUCTIONS_CHARS) {
                instructions = rawInstructions.slice(0, MAX_PRISM_INSTRUCTIONS_CHARS);
                warnings.push(
                    `Truncated systemInstructions on "${name}" from ${rawInstructions.length} to ${MAX_PRISM_INSTRUCTIONS_CHARS} chars.`
                );
            }
            const rawProfile = raw.account ?? raw.profile;
            const account: PrismProfileType =
                rawProfile === 'enterprise' || rawProfile === 'regular-1' || rawProfile === 'regular-2'
                    ? rawProfile
                    : bundleAccount;
            const incomingExtId = firstNonEmpty(raw.externalId, raw.id) || undefined;
            const requestedId = firstNonEmpty(raw.prismId, raw.gemId);

            let targetSlug = requestedId && isValidPrismId(requestedId)
                ? requestedId
                : slugifyPrismName(account !== 'custom' && raw.prefixAccount === true ? `${account}-${name}` : name);

            const existingAtSlug = loadPrism(workspaceRoot, targetSlug);
            if (existingAtSlug) {
                const accountConflict = existingAtSlug.account !== account;
                const extIdConflict = Boolean(
                    incomingExtId && existingAtSlug.externalId && existingAtSlug.externalId !== incomingExtId
                );
                if (accountConflict || extIdConflict) {
                    const disambiguated = slugifyPrismName(`${account}-${name}${incomingExtId ? `-${incomingExtId.slice(0, 6)}` : ''}`);
                    warnings.push(
                        `Disambiguated same-name Prism "${name}" (${account}) to "${disambiguated}" to preserve existing "${targetSlug}" (${existingAtSlug.account}).`
                    );
                    targetSlug = disambiguated;
                }
            }

            const rawKnowledgeList = raw.knowledgeFiles ?? raw.files ?? raw.attachments;
            const { refs: validKnowledgeRefs, rejected } = sanitizeKnowledgeRefs(targetSlug, rawKnowledgeList);
            for (const bad of rejected) {
                warnings.push(`Rejected unsafe knowledge file reference on "${name}": ${bad}`);
            }

            const savedPrism = savePrism(workspaceRoot, {
                prismId: targetSlug,
                name,
                description: typeof raw.description === 'string' ? raw.description : undefined,
                systemInstructions: instructions,
                starterPrompts: Array.isArray(raw.starterPrompts) ? raw.starterPrompts : undefined,
                account,
                accountLabel: firstNonEmpty(raw.accountLabel, rootObj.accountLabel) || undefined,
                knowledgeFiles: validKnowledgeRefs,
                externalId: incomingExtId,
                imported: true,
                importedAt,
            });
            importedPrisms.push(savedPrism);

            if (Array.isArray(rawKnowledgeList)) {
                for (const f of rawKnowledgeList) {
                    if (f && typeof f === 'object' && typeof f.name === 'string' && typeof (f.content ?? f.text) === 'string') {
                        const cleanName = f.name.trim();
                        if (isSafeKnowledgeFileName(cleanName)) {
                            savePrismKnowledgeFile(workspaceRoot, savedPrism.prismId, {
                                name: cleanName,
                                content: String(f.content ?? f.text),
                                mimeType: f.mimeType,
                                externalRefId: f.externalRefId ?? f.driveId,
                            });
                        }
                    }
                }
            }

            if (Array.isArray(raw.threads)) {
                for (const t of raw.threads) {
                    if (t && Array.isArray(t.turns) && t.turns.length > 0) {
                        savePrismThread(workspaceRoot, savedPrism.prismId, t);
                        importedThreads++;
                    }
                }
            }
        } catch (err: any) {
            skipped++;
            warnings.push(`Failed to import Prism entry: ${err?.message ?? String(err)}`);
        }
    }

    return { importedPrisms, importedThreads, skipped, warnings };
}

/**
 * Generates a vendor-neutral local JSON starter bundle template for authoring or
 * migrating custom Prism rooms into `.harmony/prisms/`.
 */
export function buildPrismBundleTemplate(profile: PrismProfileType = 'enterprise'): string {
    const template = {
        profile,
        exportedAt: new Date().toISOString(),
        prisms: [
            {
                name: 'Architecture Reviewer',
                description: 'Focused specialist lens with isolated context and local knowledge files.',
                systemInstructions: 'Review proposed changes for modularity, reversibility, and clear invariants.',
                starterPrompts: ['Audit the proposed module boundaries and list concrete edge cases.'],
                knowledgeFiles: [
                    {
                        name: 'invariants.md',
                        content: '# Project Invariants\n- Prove defects before writing fixes.\n- Keep context isolated per room.\n',
                    },
                ],
                threads: [],
            },
        ],
    };
    return JSON.stringify(template, null, 2);
}
