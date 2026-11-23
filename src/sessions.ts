import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

/**
 * Workspace-scoped chat session persistence.
 *
 * A "session" is a snapshot of recent prompts/responses the user wants to
 * resume later. Stored in .harmony/sessions/{name}.json. Free-form, no
 * schema validation \u2014 just user-readable JSON they can hand-edit.
 *
 * NOTE: this is NOT live conversation history (VS Code chat owns that).
 * It's a "save these turns under a name so I can re-prime later" tool.
 */

export interface SessionTurn {
    role: 'user' | 'assistant';
    text: string;
    ts: string;
}

/**
 * Where a saved session's turns came from.
 * - `chat-history`: the real VS Code chat transcript (authoritative).
 * - `harmony-chat`: the Harmony chat panel's live transcript. Also authoritative -
 *   it is captured turn by turn as the conversation happens, not reconstructed.
 * - `memory-reconstruction`: derived from the memory store. Turn boundaries and
 *   timestamps are approximate, so it must never present itself as a transcript.
 */
export type SessionSource = 'chat-history' | 'harmony-chat' | 'memory-reconstruction';

/** Bumped when the on-disk session shape changes. Absent means pre-v1; v2 adds extractive `digest`. */
export const SESSION_SCHEMA_VERSION = 2;

export interface SessionDigest {
    turnCount: number;
    userTurns: number;
    assistantTurns: number;
    totalChars: number;
    /** Deterministic sorted list of workspace-relative file paths mentioned in turns. */
    filesMentioned: string[];
    /** Extractive highlights of key decisions, outcomes, or completed work. */
    decisions: string[];
    /** Extractive open items, follow-ups, or pending actions. */
    openItems: string[];
}

export interface SessionFile {
    name: string;
    created: string;
    updated: string;
    turns: SessionTurn[];
    notes?: string;
    /** Provenance. Absent on files written before this field existed. */
    source?: SessionSource;
    schemaVersion?: number;
    /** Deterministic extractive digest computed at save time (v2+). Optional; v1 files load without migration. */
    digest?: SessionDigest;
}

const FILE_PATH_PATTERN = /(?:^|[\s`'"(\[])((?:src|scripts|test|docs|native-ui|bin|media|locales|\.harmony)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+|package(?:\.nls(?:\.zh-cn)?)?\.json|tsconfig\.json|AGENTS\.md|README\.md|NOTICE\.md)/g;

/**
 * Deterministic, zero-model-cost extractive digest computed at save time.
 * Never invents facts: every file path, decision line, and open item is
 * extracted verbatim from the normalized turns.
 */
export function buildExtractiveSessionDigest(turns: SessionTurn[]): SessionDigest {
    const safeTurns = Array.isArray(turns) ? turns : [];
    let userTurns = 0;
    let assistantTurns = 0;
    let totalChars = 0;
    const fileSet = new Set<string>();
    const decisions: string[] = [];
    const openItems: string[] = [];
    const seenDecisions = new Set<string>();
    const seenOpen = new Set<string>();

    for (const turn of safeTurns) {
        if (!turn || typeof turn.text !== 'string') continue;
        if (turn.role === 'assistant') assistantTurns++;
        else userTurns++;
        totalChars += turn.text.length;

        FILE_PATH_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = FILE_PATH_PATTERN.exec(turn.text)) !== null) {
            if (match[1]) fileSet.add(match[1]);
        }

        const lines = turn.text.split(/\r?\n/);
        for (const rawLine of lines) {
            const clean = rawLine.replace(/^[-*•#\d.)\s]+/, '').trim();
            if (clean.length < 10 || clean.length > 220) continue;
            const lower = clean.toLowerCase();
            if (
                decisions.length < 6 &&
                (turn.role === 'assistant' || /^decision:/i.test(clean)) &&
                (/\b(landed|verified|fixed|implemented|wired|packaged|installed|decided|chosen|resolved|passed)\b/i.test(clean) ||
                    /^[✅✔]/.test(rawLine.trim()))
            ) {
                if (!seenDecisions.has(lower)) {
                    seenDecisions.add(lower);
                    decisions.push(clean);
                }
            } else if (
                openItems.length < 6 &&
                (/\b(todo|pending|next step|follow-up|reload owed|blocked|remaining)\b/i.test(clean) ||
                    /^[-*]\s*\[\s\]/.test(rawLine.trim()))
            ) {
                if (!seenOpen.has(lower)) {
                    seenOpen.add(lower);
                    openItems.push(clean);
                }
            }
        }
    }

    const filesMentioned = Array.from(fileSet).sort().slice(0, 25);
    return {
        turnCount: safeTurns.length,
        userTurns,
        assistantTurns,
        totalChars,
        filesMentioned,
        decisions,
        openItems,
    };
}

function sessionsDir(): vscode.Uri | null {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return null;
    return vscode.Uri.joinPath(ws.uri, '.harmony', 'sessions');
}

async function ensureDir(dir: vscode.Uri): Promise<void> {
    try { await vscode.workspace.fs.createDirectory(dir); } catch { /* ignore */ }
}

function sanitize(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60) || 'session';
}

export async function listSessions(): Promise<string[]> {
    const dir = sessionsDir();
    if (!dir) return [];
    try {
        const entries = await vscode.workspace.fs.readDirectory(dir);
        return entries
            .filter(([n, t]) => t === vscode.FileType.File && n.endsWith('.json'))
            .map(([n]) => n.replace(/\.json$/, ''))
            .sort();
    } catch {
        return [];
    }
}

export async function saveSession(
    name: string,
    turns: SessionTurn[],
    notes?: string,
    meta?: { source?: SessionSource }
): Promise<string> {
    const dir = sessionsDir();
    if (!dir) throw new Error('No workspace open \u2014 cannot save session.');
    await ensureDir(dir);
    const safe = sanitize(name);
    const file = vscode.Uri.joinPath(dir, `${safe}.json`);
    let existing: SessionFile | null = null;
    try {
        const buf = await vscode.workspace.fs.readFile(file);
        existing = JSON.parse(new TextDecoder('utf-8').decode(buf));
    } catch { /* new file */ }
    const now = new Date().toISOString();
    const digest = buildExtractiveSessionDigest(turns);
    const data: SessionFile = {
        name: safe,
        created: existing?.created ?? now,
        updated: now,
        turns,
        notes: notes ?? existing?.notes,
        source: meta?.source ?? existing?.source,
        schemaVersion: SESSION_SCHEMA_VERSION,
        digest,
    };
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(JSON.stringify(data, null, 2)));
    return safe;
}

/**
 * Normalises any caller's turn shape into `SessionTurn[]`.
 *
 * Two live producers exist and they do NOT agree on the field name:
 * - the VS Code chat participant sends `{ role, text }`
 * - the Harmony chat panel keeps `{ role, content }` in its transcript
 *
 * Reading only one of those silently dropped every turn and made `/save` report
 * "every turn was empty". Both shapes are accepted here and only here, so a
 * future producer can't reintroduce the mismatch at a call site.
 */
export function normalizeChatTurns(raw: unknown): SessionTurn[] {
    if (!Array.isArray(raw)) return [];
    const out: SessionTurn[] = [];
    const now = new Date().toISOString();
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const turn = entry as { role?: unknown; text?: unknown; content?: unknown; ts?: unknown };
        const text = typeof turn.text === 'string'
            ? turn.text
            : typeof turn.content === 'string'
                ? turn.content
                : '';
        if (!text.trim()) continue;
        out.push({
            role: turn.role === 'assistant' ? 'assistant' : 'user',
            text,
            ts: typeof turn.ts === 'string' && turn.ts ? turn.ts : now
        });
    }
    return out;
}

export type SaveChatResult =
    | { ok: true; name: string; turns: number; source: SessionSource; digest: SessionDigest }
    | { ok: false; error: string };

/**
 * Single save entry point shared by every transport (HTTP route, webview route,
 * and any future surface). The old code carried two hand-written copies of this
 * normalisation, which is how the `text` / `content` mismatch survived.
 */
export async function saveChatSession(
    name: string,
    rawTurns: unknown,
    source: SessionSource = 'harmony-chat',
    workspaceRoot?: string
): Promise<SaveChatResult> {
    if (typeof workspaceRoot === 'string' && workspaceRoot.trim()) {
        return saveStudioSession(workspaceRoot, name, rawTurns, source);
    }
    const safeName = String(name ?? '').trim();
    if (!safeName) return { ok: false, error: 'Usage: /save <name>' };
    if (!Array.isArray(rawTurns) || rawTurns.length === 0) {
        return { ok: false, error: 'Nothing to save yet — send at least one message in this thread, then run /save again.' };
    }
    const turns = normalizeChatTurns(rawTurns);
    if (turns.length === 0) {
        return { ok: false, error: 'Nothing to save yet — every turn in this thread was empty.' };
    }
    try {
        const digest = buildExtractiveSessionDigest(turns);
        const saved = await saveSession(safeName, turns, undefined, { source });
        return { ok: true, name: saved, turns: turns.length, source, digest };
    } catch (err: any) {
        return { ok: false, error: `Save failed: ${err?.message ?? String(err)}` };
    }
}

const WINDOWS_RESERVED_SESSION_NAMES = new Set([
    'con', 'prn', 'aux', 'nul',
    'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
    'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export const STUDIO_MAX_SESSION_TURNS = 120;
export const STUDIO_MAX_SESSION_BYTES = 512 * 1024;
export const STUDIO_AUTOSAVE_SESSION_NAME = '_autosave';

export interface SavedSessionSummary {
    name: string;
    created: string;
    updated: string;
    turnCount: number;
    source?: SessionSource;
    isAutosave: boolean;
    preview: string;
    digest?: SessionDigest;
}

/**
 * Strict session identifier validator for HTTP `:8789` and Webview Studio routes.
 * Rejects traversal tokens (`..`, `/`, `\`, `%`, `:`, NUL), leading/trailing dots,
 * and Windows reserved device names before normalizing spaces into underscores.
 */
export function validateStudioSessionName(
    raw: unknown,
    options?: { allowSpaces?: boolean }
): { ok: true; safe: string } | { ok: false; error: string } {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) {
        return { ok: false, error: 'Missing session name.' };
    }
    if (trimmed.length > 80) {
        return { ok: false, error: 'Session name must be 64 characters or fewer.' };
    }
    if (
        trimmed.includes('..') ||
        trimmed.includes('/') ||
        trimmed.includes('\\') ||
        trimmed.includes('%') ||
        trimmed.includes(':') ||
        /[\x00-\x1f\x7f]/.test(trimmed) ||
        trimmed.startsWith('.') ||
        trimmed.endsWith('.')
    ) {
        return { ok: false, error: 'Invalid session name (path characters and leading/trailing dots are not allowed).' };
    }
    const candidate = options?.allowSpaces !== false
        ? trimmed.replace(/\s+/g, '_')
        : trimmed;
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(candidate)) {
        return { ok: false, error: 'Session name may only contain letters, numbers, hyphens, underscores, and dots.' };
    }
    const stemLower = candidate.split('.')[0].toLowerCase();
    if (WINDOWS_RESERVED_SESSION_NAMES.has(stemLower)) {
        return { ok: false, error: `Reserved session name "${candidate}" is not allowed.` };
    }
    return { ok: true, safe: candidate };
}

function resolveContainedSessionFile(
    workspaceRoot: string,
    safeName: string
): { dirAbs: string; fileAbs: string } | null {
    if (!workspaceRoot || typeof workspaceRoot !== 'string') return null;
    const rootAbs = path.resolve(workspaceRoot);
    const dirAbs = path.join(rootAbs, '.harmony', 'sessions');
    const fileAbs = path.resolve(dirAbs, `${safeName}.json`);
    const rel = path.relative(dirAbs, fileAbs);
    if (!rel || rel !== `${safeName}.json` || rel.startsWith('..') || path.isAbsolute(rel)) {
        return null;
    }
    try {
        if (fs.existsSync(dirAbs)) {
            const dirStat = fs.lstatSync(dirAbs);
            if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;
        }
        if (fs.existsSync(fileAbs)) {
            const fileStat = fs.lstatSync(fileAbs);
            if (fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
        }
    } catch {
        return null;
    }
    return { dirAbs, fileAbs };
}

export async function saveStudioSession(
    workspaceRoot: string,
    name: string,
    rawTurns: unknown,
    source: SessionSource = 'harmony-chat'
): Promise<SaveChatResult> {
    const check = validateStudioSessionName(name, { allowSpaces: true });
    if (!check.ok) {
        return { ok: false, error: check.error };
    }
    if (!Array.isArray(rawTurns) || rawTurns.length === 0) {
        return { ok: false, error: 'Nothing to save yet — send at least one message in this thread, then run /save again.' };
    }
    const normalized = normalizeChatTurns(rawTurns).slice(-STUDIO_MAX_SESSION_TURNS);
    if (normalized.length === 0) {
        return { ok: false, error: 'Nothing to save yet — every turn in this thread was empty.' };
    }
    const target = resolveContainedSessionFile(workspaceRoot, check.safe);
    if (!target) {
        return { ok: false, error: 'Session storage path rejected by workspace containment check.' };
    }
    try {
        await fsp.mkdir(target.dirAbs, { recursive: true });
        const dirStat = await fsp.lstat(target.dirAbs);
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
            return { ok: false, error: 'Session directory rejected (symlink or non-directory).' };
        }
        let existing: SessionFile | null = null;
        try {
            const rawExisting = await fsp.readFile(target.fileAbs, 'utf8');
            existing = JSON.parse(rawExisting);
        } catch { /* new file */ }
        const now = new Date().toISOString();
        const digest = buildExtractiveSessionDigest(normalized);
        const data: SessionFile = {
            name: check.safe,
            created: existing?.created ?? now,
            updated: now,
            turns: normalized,
            notes: existing?.notes,
            source: source ?? existing?.source ?? 'harmony-chat',
            schemaVersion: SESSION_SCHEMA_VERSION,
            digest,
        };
        const serialized = JSON.stringify(data, null, 2);
        if (Buffer.byteLength(serialized, 'utf8') > STUDIO_MAX_SESSION_BYTES) {
            return { ok: false, error: `Session exceeds maximum size (${STUDIO_MAX_SESSION_BYTES} bytes).` };
        }
        const tmpAbs = `${target.fileAbs}.${process.pid}.${Date.now()}.tmp`;
        await fsp.writeFile(tmpAbs, serialized, 'utf8');
        await fsp.rename(tmpAbs, target.fileAbs);
        return { ok: true, name: check.safe, turns: normalized.length, source: data.source || 'harmony-chat', digest };
    } catch (err: any) {
        return { ok: false, error: `Save failed: ${err?.message ?? String(err)}` };
    }
}

export async function loadStudioSession(
    workspaceRoot: string,
    name: string
): Promise<{ ok: true; session: SessionFile } | { ok: false; error: string }> {
    const check = validateStudioSessionName(name, { allowSpaces: false });
    if (!check.ok) return { ok: false, error: check.error };
    const target = resolveContainedSessionFile(workspaceRoot, check.safe);
    if (!target) return { ok: false, error: 'Session path rejected by containment check.' };
    try {
        const stat = await fsp.lstat(target.fileAbs);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            return { ok: false, error: 'Session file rejected.' };
        }
        if (stat.size > STUDIO_MAX_SESSION_BYTES * 2) {
            return { ok: false, error: 'Session file exceeds safety size limit.' };
        }
        const raw = await fsp.readFile(target.fileAbs, 'utf8');
        const parsed = JSON.parse(raw) as SessionFile;
        const turns = normalizeChatTurns(parsed?.turns).slice(-STUDIO_MAX_SESSION_TURNS);
        return {
            ok: true,
            session: {
                name: check.safe,
                created: typeof parsed?.created === 'string' ? parsed.created : new Date().toISOString(),
                updated: typeof parsed?.updated === 'string' ? parsed.updated : new Date().toISOString(),
                turns,
                notes: typeof parsed?.notes === 'string' ? parsed.notes : undefined,
                source: parsed?.source,
                schemaVersion: parsed?.schemaVersion,
                digest: parsed?.digest ?? buildExtractiveSessionDigest(turns),
            },
        };
    } catch {
        return { ok: false, error: `Session "${check.safe}" not found.` };
    }
}

export async function listStudioSessions(workspaceRoot: string): Promise<SavedSessionSummary[]> {
    if (!workspaceRoot || typeof workspaceRoot !== 'string') return [];
    const dirAbs = path.join(path.resolve(workspaceRoot), '.harmony', 'sessions');
    try {
        const dirStat = await fsp.lstat(dirAbs);
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return [];
        const entries = await fsp.readdir(dirAbs, { withFileTypes: true });
        const summaries: SavedSessionSummary[] = [];
        for (const ent of entries) {
            if (!ent.isFile() || ent.isSymbolicLink() || !ent.name.endsWith('.json')) continue;
            const stem = ent.name.slice(0, -5);
            const valid = validateStudioSessionName(stem, { allowSpaces: false });
            if (!valid.ok) continue;
            const loaded = await loadStudioSession(workspaceRoot, valid.safe);
            if (!loaded.ok) continue;
            const s = loaded.session;
            const lastTurn = s.turns[s.turns.length - 1];
            summaries.push({
                name: s.name,
                created: s.created,
                updated: s.updated,
                turnCount: s.turns.length,
                source: s.source,
                isAutosave: s.name === STUDIO_AUTOSAVE_SESSION_NAME,
                preview: lastTurn ? lastTurn.text.replace(/\s+/g, ' ').slice(0, 140) : '(empty)',
                digest: s.digest,
            });
        }
        summaries.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
        return summaries.slice(0, 40);
    } catch {
        return [];
    }
}

export async function deleteStudioSession(
    workspaceRoot: string,
    name: string
): Promise<{ ok: boolean; deleted?: string; error?: string }> {
    const check = validateStudioSessionName(name, { allowSpaces: false });
    if (!check.ok) return { ok: false, error: check.error };
    const target = resolveContainedSessionFile(workspaceRoot, check.safe);
    if (!target) return { ok: false, error: 'Session path rejected by containment check.' };
    try {
        const stat = await fsp.lstat(target.fileAbs);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            return { ok: false, error: 'Session file rejected.' };
        }
        await fsp.unlink(target.fileAbs);
        return { ok: true, deleted: check.safe };
    } catch {
        return { ok: false, error: `Session "${check.safe}" not found.` };
    }
}

export async function loadSession(name: string): Promise<SessionFile | null> {
    const dir = sessionsDir();
    if (!dir) return null;
    const safe = sanitize(name);
    const file = vscode.Uri.joinPath(dir, `${safe}.json`);
    try {
        const buf = await vscode.workspace.fs.readFile(file);
        return JSON.parse(new TextDecoder('utf-8').decode(buf));
    } catch {
        return null;
    }
}

export async function deleteSession(name: string): Promise<boolean> {
    const dir = sessionsDir();
    if (!dir) return false;
    const safe = sanitize(name);
    const file = vscode.Uri.joinPath(dir, `${safe}.json`);
    try {
        await vscode.workspace.fs.delete(file);
        return true;
    } catch {
        return false;
    }
}

/**
 * Soft budget for a resumed-session preamble, in characters (~2k tokens).
 * Under this size the preamble is returned verbatim with no annotation.
 */
export const SESSION_PREAMBLE_TARGET_CHARS = 8000;

/**
 * Hard ceiling for a resumed-session preamble, in characters (~6k tokens).
 * Never exceeded. The newest turn is allowed to spend this whole budget before
 * being stitched, because no compression layer exists yet: losing the most
 * recent exchange is worse than an over-target preamble.
 */
export const SESSION_PREAMBLE_CEILING_CHARS = 24000;

/** Room reserved for the context manifest line when trimming. */
const PREAMBLE_NOTICE_RESERVE = 200;

/** Smallest meaningful side when head+tail stitching a single oversized turn. */
const HEAD_TAIL_MIN_SIDE = 300;

export interface SessionPreambleOptions {
    targetChars?: number;
    ceilingChars?: number;
}

/**
 * Keep both ends of an oversized block, with the omission counted in between.
 * Meaning lives at both ends: the head establishes intent, the tail carries the
 * conclusion or exception. Head-only truncation loses exactly what is wanted.
 */
function headTailStitch(text: string, room: number): string {
    if (room <= 0) return '';
    if (text.length <= room) return text;

    const INLINE_MARKER_RESERVE = 40;
    const available = room - INLINE_MARKER_RESERVE;
    if (available < HEAD_TAIL_MIN_SIDE * 2) {
        // Too tight to honour both ends: keep the tail, where conclusions live.
        const keep = Math.max(room - 1, 0);
        return `…${text.slice(text.length - keep)}`;
    }

    const headLen = Math.floor(available * 0.55);
    const tailLen = available - headLen;
    const head = text.slice(0, headLen);
    const tail = text.slice(text.length - tailLen);
    const omitted = text.length - headLen - tailLen;
    return `${head}\n…[${omitted} chars omitted]…\n${tail}`;
}

/**
 * Render a saved session back into prompt-ready text.
 *
 * Tiered degradation, in order:
 *   1. Under TARGET            -> verbatim, no annotation.
 *   2. TARGET..CEILING         -> verbatim plus an over-target note. Nothing lost.
 *   3. Over CEILING            -> whole turns trimmed oldest-first; the newest
 *                                 turn keeps ceiling rights before any older
 *                                 turn is admitted.
 *   4. Newest turn alone > cap -> head+tail stitch with the omission counted.
 *
 * Every degradation is announced with its magnitude. A trim the reader cannot
 * measure is a silent failure.
 */
export function formatSessionPreamble(s: SessionFile, options?: SessionPreambleOptions): string {
    const targetChars = options?.targetChars ?? SESSION_PREAMBLE_TARGET_CHARS;
    const ceilingChars = options?.ceilingChars ?? SESSION_PREAMBLE_CEILING_CHARS;

    const headerLines: string[] = [`[Resumed session: "${s.name}", saved ${s.updated}]`];
    if (s.source === 'memory-reconstruction') {
        // Declare degraded fidelity. A reconstruction must never present itself
        // as a transcript: boundaries and timestamps were inferred, not observed.
        headerLines.push('[Provenance: reconstructed from memory \u2014 turn boundaries and timestamps are approximate]');
    }
    if (s.notes) headerLines.push(`Notes: ${s.notes}`);
    headerLines.push('');
    headerLines.push('Prior conversation:');
    const headerText = headerLines.join('\n');

    const blocks = s.turns.map((t) => `${t.role === 'user' ? 'User' : 'Conductor'}: ${t.text}`);
    const full = blocks.length ? `${headerText}\n${blocks.join('\n\n')}` : headerText;

    // ── Tier 1: under target, untouched ──────────────────────────────────
    if (full.length <= targetChars) return full;

    // ── Tier 2: over target but within ceiling, keep everything ──────────
    const noun = blocks.length === 1 ? 'turn' : 'turns';
    const overTargetNotice =
        `[Context: ${blocks.length} ${noun} saved · over target (${full.length} / ${targetChars} chars)`
        + ' · complete, nothing omitted]';
    if (full.length + 2 + overTargetNotice.length <= ceilingChars) {
        return `${full}\n\n${overTargetNotice}`;
    }

    // ── Tier 3/4: trim. Newest turn gets ceiling rights, older get target ─
    const ceilingBudget = ceilingChars - PREAMBLE_NOTICE_RESERVE;
    const kept: string[] = [];
    let used = headerText.length;
    let stitched = false;

    if (blocks.length) {
        const newest = blocks[blocks.length - 1];
        if (used + newest.length + 1 <= ceilingBudget) {
            kept.push(newest);
            used += newest.length + 1;
        } else {
            const stitchedNewest = headTailStitch(newest, ceilingBudget - used - 1);
            if (stitchedNewest) {
                kept.push(stitchedNewest);
                used += stitchedNewest.length + 1;
                stitched = true;
            }
        }
    }

    for (let i = blocks.length - 2; i >= 0; i--) {
        const block = blocks[i];
        if (used + block.length + 2 > targetChars) break;
        kept.unshift(block);
        used += block.length + 2;
    }

    const omitted = blocks.length - kept.length;
    const manifestParts: string[] = [`${blocks.length} ${noun} saved`];
    manifestParts.push(stitched ? `${kept.length} recent, newest head+tail stitched` : `${kept.length} recent verbatim`);
    if (omitted > 0) manifestParts.push(`${omitted} earlier ${omitted === 1 ? 'turn' : 'turns'} omitted`);
    const manifest = `[Context: ${manifestParts.join(' · ')}]`;

    let output = kept.length
        ? `${headerText}\n${kept.join('\n\n')}\n\n${manifest}`
        : `${headerText}\n\n${manifest}`;

    // Belt and braces: the ceiling is absolute even if the header alone is huge.
    if (output.length > ceilingChars) {
        const clampNotice = '\n\n[Context: hard ceiling reached — content truncated]';
        output = output.slice(0, Math.max(ceilingChars - clampNotice.length, 0)) + clampNotice;
    }
    return output;
}
