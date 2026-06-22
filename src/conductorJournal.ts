/**
 * Conductor's Journal — Cognitive offloading tool for the Harmony conductor.
 * Cross-workspace, user-level persistent scratchpad for intermediate reasoning.
 * 
 * Location: ~/.harmony/conductor-journal/
 * 
 * Features:
 * - Per-session entries with workspace fingerprinting
 * - Auto-compaction of entries older than 7 days
 * - Decision ledger with rationale tracking
 * - Session metrics (commits, tool calls, duration)
 * - Cross-workspace context injection
 * - Wellness tracking for long sessions
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// ── Types ──

export interface JournalEntry {
    id: string;
    timestamp: number;
    date: string;           // YYYY-MM-DD
    workspace: string;       // workspace fingerprint
    workspace_name: string;  // human-readable folder name
    branch: string;
    title: string;
    content: string;         // full markdown
    decisions: JournalDecision[];
    metrics: JournalMetrics;
    tags: string[];
    compacted: boolean;
}

export interface JournalDecision {
    decision: string;
    rationale: string;
    alternatives: string[];
    timestamp: number;
}

export interface JournalMetrics {
    commits: number;
    files_changed: number;
    tool_calls_approx: number;
    session_duration_min: number;
    todos_completed: number;
    todos_pending: number;
}

export interface JournalIndex {
    entries: { id: string; date: string; workspace: string; title: string; tags: string[]; compacted: boolean }[];
    last_updated: number;
    total_entries: number;
    total_size_bytes: number;
    workspaces: string[];
}

export interface JournalStats {
    total_entries: number;
    total_decisions: number;
    entries_this_week: number;
    entries_this_month: number;
    longest_session_min: number;
    avg_session_min: number;
    most_active_workspace: string;
    recent_tags: string[];
    wellness: {
        sessions_today: number;
        total_minutes_today: number;
        flag_long_session: boolean;
    };
}

// ── Constants ──

const JOURNAL_ROOT = path.join(os.homedir(), '.harmony', 'conductor-journal');
const ENTRIES_DIR = path.join(JOURNAL_ROOT, 'entries');
const COMPACTED_DIR = path.join(JOURNAL_ROOT, 'compacted');
const INDEX_PATH = path.join(JOURNAL_ROOT, 'index.json');
const COMPACTION_AGE_DAYS = 7;
const MAX_ENTRIES_BEFORE_COMPACTION = 50;

// ── Helpers ──

function uid(): string {
    return `j-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function today(): string {
    return new Date().toISOString().slice(0, 10);
}

function daysAgo(dateStr: string): number {
    const d = new Date(dateStr);
    const now = new Date();
    return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

async function ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
}

async function readJsonSafe(fp: string): Promise<any | null> {
    try {
        const raw = await fs.readFile(fp, 'utf8');
        return JSON.parse(raw);
    } catch { return null; }
}

async function writeJsonSafe(fp: string, data: any): Promise<void> {
    try {
        // Atomic write: write to temp file, then rename
        const tmp = fp + '.tmp.' + Date.now();
        await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
        await fs.rename(tmp, fp);
    } catch (e: any) {
        throw new Error(`Journal write failed for ${fp}: ${e?.message ?? String(e)}`);
    }
}

// ── Encryption helpers ──
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEY_LENGTH = 32;
const SALT_PATH = path.join(JOURNAL_ROOT, '.salt');

async function getOrCreateSalt(): Promise<Buffer> {
    try {
        await ensureDir(JOURNAL_ROOT);
        const existing = await fs.readFile(SALT_PATH);
        if (existing.length === SALT_LENGTH) return existing;
    } catch { /* salt doesn't exist yet */ }
    // Create new random salt
    const salt = crypto.randomBytes(SALT_LENGTH);
    await fs.writeFile(SALT_PATH, salt);
    return salt;
}

async function getEncryptionKey(): Promise<Buffer> {
    try {
        const salt = await getOrCreateSalt();
        const passphrase = os.hostname() + ':harmony-conductor-journal:v2';
        return new Promise((resolve, reject) => {
            crypto.pbkdf2(passphrase, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, 'sha512', (err, key) => {
                if (err) reject(new Error(`Key derivation failed: ${err.message}`));
                else resolve(key);
            });
        });
    } catch (e: any) {
        throw new Error(`Journal key setup failed: ${e?.message ?? String(e)}`);
    }
}

async function encryptContent(plaintext: string): Promise<string> {
    try {
        const key = await getEncryptionKey();
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const authTag = cipher.getAuthTag();
        return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
    } catch (e: any) {
        throw new Error(`Journal encryption failed: ${e?.message ?? String(e)}`);
    }
}

async function decryptContent(ciphertext: string): Promise<string | null> {
    try {
        const key = await getEncryptionKey();
        const parts = ciphertext.split(':');
        if (parts.length !== 3) return null;
        const iv = Buffer.from(parts[0], 'base64');
        const authTag = Buffer.from(parts[1], 'base64');
        const encrypted = Buffer.from(parts[2], 'base64');
        if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) return null;
        const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch {
        return null;
    }
}

// ── Path sanitization ──
function sanitizeFingerprint(raw: string): string {
    const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 64);
    if (!cleaned || cleaned === '.' || cleaned === '..') return 'unknown-workspace';
    return cleaned;
}

// ── ConductorJournal Class ──

export class ConductorJournal {
    private workspaceName: string;
    private workspaceFingerprint: string;
    private initialized: boolean = false;

    constructor(workspaceRoot?: string, workspaceFingerprint?: string) {
        this.workspaceName = workspaceRoot ? path.basename(workspaceRoot) : 'unknown';
        const raw = workspaceFingerprint ?? this.workspaceName;
        this.workspaceFingerprint = sanitizeFingerprint(raw);
    }

    async init(): Promise<void> {
        await ensureDir(ENTRIES_DIR);
        await ensureDir(COMPACTED_DIR);
        // Create index if missing
        const existing = await readJsonSafe(INDEX_PATH);
        if (!existing) {
            await writeJsonSafe(INDEX_PATH, {
                entries: [],
                last_updated: Date.now(),
                total_entries: 0,
                total_size_bytes: 0,
                workspaces: [],
            });
        }
        // Reconcile index with actual files on disk
        await this.syncIndex();
        // Auto-load context for system prompt injection
        this._cachedContext = await this.getContextInjection(3, 2000);
        this.initialized = true;
    }

    // ── Cached context for active injection ──
    private _cachedContext: string = '';

    getCachedContext(): string {
        return this._cachedContext;
    }

    async refreshContext(): Promise<string> {
        this._cachedContext = await this.getContextInjection(3, 2000);
        return this._cachedContext;
    }

    // ── Semantic auto-tagging ──
    private static readonly AUTO_TAG_MAP: Record<string, string[]> = {
        'swarm': ['swarm', 'worker', 'agent', 'topology', 'topos', 'parallel', 'orchestrat'],
        'primitives': ['primitive', 'capability', 'missing', 'audit', 'quality', 'score', 'enterprise'],
        'consensus': ['consensus', 'alignment', 'debate', 'agree', 'review', 'critique'],
        'orchestra': ['orchestra', 'worker', 'model', 'heavy', 'provider'],
        'security': ['security', 'encrypt', 'decrypt', 'safe', 'threat', 'protect', 'sanitiz'],
        'git': ['git', 'commit', 'push', 'branch', 'remote', 'origin', 'merge', 'rebase'],
        'documentation': ['readme', 'doc', 'translation', 'i18n', 'zh', 'chinese', 'english'],
        'journal': ['journal', 'conductor', 'offload', 'cognitive', 'context'],
        'sidebar': ['sidebar', 'ui', 'webview', 'panel', 'toggle', 'render'],
        'build': ['compile', 'package', 'vsix', 'install', 'npm', 'typescript'],
        'flow-state': ['flow', 'continue', 'session', 'whisper', 'ask_question'],
        'fix': ['fix', 'bug', 'error', 'issue', 'repair', 'broken'],
    };

    private autoDetectTags(content: string, title: string): string[] {
        const combined = `${title} ${content}`.toLowerCase();
        const tags: string[] = [];
        for (const [tag, keywords] of Object.entries(ConductorJournal.AUTO_TAG_MAP)) {
            if (keywords.some(kw => combined.includes(kw))) {
                tags.push(tag);
            }
        }
        return tags;
    }

    // ── Index Sync (reconcile index.json with entries/ directory) ──
    private async syncIndex(): Promise<void> {
        const index: JournalIndex = await readJsonSafe(INDEX_PATH);
        if (!index) return;
        
        // Get all actual entry files on disk
        let diskFiles: string[] = [];
        try {
            diskFiles = await fs.readdir(ENTRIES_DIR);
        } catch { return; }
        
        const diskIds = new Set<string>();
        for (const fname of diskFiles) {
            if (!fname.endsWith('.md')) continue;
            // Filename format: YYYY-MM-DD-j-xxx.md
            const idMatch = fname.match(/\d{4}-\d{2}-\d{2}-(j-[a-z0-9]+)\.md$/);
            if (idMatch) diskIds.add(idMatch[1]);
        }
        
        // Remove index entries whose files don't exist
        const before = index.entries.length;
        index.entries = index.entries.filter(e => diskIds.has(e.id));
        
        // Add entries for files not in the index
        for (const id of diskIds) {
            if (!index.entries.some(e => e.id === id)) {
                const fname = diskFiles.find(f => f.includes(id));
                const dateMatch = fname?.match(/^(\d{4}-\d{2}-\d{2})/);
                index.entries.push({
                    id,
                    date: dateMatch?.[1] ?? today(),
                    workspace: 'unknown',
                    title: '(recovered entry)',
                    tags: [],
                    compacted: false,
                });
            }
        }
        
        index.total_entries = index.entries.length;
        index.last_updated = Date.now();
        
        if (index.entries.length !== before) {
            await writeJsonSafe(INDEX_PATH, index);
        }
    }

    private async ensureInit(): Promise<void> {
        if (!this.initialized) await this.init();
    }

    // ── Write Entry ──

    async writeEntry(opts: {
        title: string;
        content: string;
        decisions?: { decision: string; rationale: string; alternatives?: string[] }[];
        metrics?: Partial<JournalMetrics>;
        tags?: string[];
        branch?: string;
    }): Promise<{ id: string; path: string }> {
        await this.ensureInit();

        const id = uid();
        const date = today();
        const entry: JournalEntry = {
            id,
            timestamp: Date.now(),
            date,
            workspace: this.workspaceFingerprint,
            workspace_name: this.workspaceName,
            branch: opts.branch ?? 'unknown',
            title: opts.title,
            content: opts.content,
            decisions: (opts.decisions ?? []).map(d => ({
                decision: d.decision,
                rationale: d.rationale,
                alternatives: d.alternatives ?? [],
                timestamp: Date.now(),
            })),
            metrics: {
                commits: opts.metrics?.commits ?? 0,
                files_changed: opts.metrics?.files_changed ?? 0,
                tool_calls_approx: opts.metrics?.tool_calls_approx ?? 0,
                session_duration_min: opts.metrics?.session_duration_min ?? 0,
                todos_completed: opts.metrics?.todos_completed ?? 0,
                todos_pending: opts.metrics?.todos_pending ?? 0,
            },
            tags: opts.tags ?? [],
            compacted: false,
        };

        // Auto-detect tags from content if none provided
        if (!opts.tags || opts.tags.length === 0) {
            entry.tags = this.autoDetectTags(entry.content, entry.title);
        } else {
            // Merge user tags with auto-detected
            const detected = this.autoDetectTags(entry.content, entry.title);
            const merged = new Set([...opts.tags, ...detected]);
            entry.tags = [...merged];
        }

        // Write entry file (content encrypted)
        const entryPath = path.join(ENTRIES_DIR, `${date}-${id}.md`);
        const md = this.formatEntry(entry);
        const encryptedMd = await this.encryptEntryContent(md);
        await fs.writeFile(entryPath, encryptedMd, 'utf8');

        // Update index
        const index: JournalIndex = await readJsonSafe(INDEX_PATH);
        index.entries.push({
            id, date, workspace: this.workspaceFingerprint,
            title: opts.title, tags: opts.tags ?? [], compacted: false,
        });
        index.last_updated = Date.now();
        index.total_entries = index.entries.length;
        if (!index.workspaces.includes(this.workspaceFingerprint)) {
            index.workspaces.push(this.workspaceFingerprint);
        }
        try { index.total_size_bytes += (await fs.stat(entryPath)).size; } catch {}
        await writeJsonSafe(INDEX_PATH, index);

        // Trigger auto-compaction if needed
        if (index.entries.length > MAX_ENTRIES_BEFORE_COMPACTION) {
            await this.compact().catch(() => {});
        }

        return { id, path: entryPath };
    }

    // ── Read Recent ──

    async readRecent(limit: number = 5, workspace?: string): Promise<JournalEntry[]> {
        await this.ensureInit();
        const index: JournalIndex = await readJsonSafe(INDEX_PATH);
        const filtered = workspace
            ? index.entries.filter(e => e.workspace === workspace)
            : index.entries;
        const recent = filtered.slice(-limit);
        
        const entries: JournalEntry[] = [];
        for (const meta of recent) {
            const entryPath = path.join(ENTRIES_DIR, `${meta.date}-${meta.id}.md`);
            try {
                const raw = await fs.readFile(entryPath, 'utf8');
                entries.push(this.parseEntry(raw, meta));
            } catch { /* entry may have been compacted */ }
        }
        return entries;
    }

    // ── Read Entry by ID ──

    async readEntry(id: string): Promise<JournalEntry | null> {
        await this.ensureInit();
        const index: JournalIndex = await readJsonSafe(INDEX_PATH);
        const meta = index.entries.find(e => e.id === id);
        if (!meta) return null;
        const entryPath = path.join(ENTRIES_DIR, `${meta.date}-${id}.md`);
        try {
            const raw = await fs.readFile(entryPath, 'utf8');
            const decrypted = await this.decryptEntryContent(raw);
            return this.parseEntry(decrypted, meta);
        } catch { return null; }
    }

    // ── Compact Old Entries ──

    async compact(beforeDate?: string): Promise<{ compacted: number; summary: string }> {
        await this.ensureInit();
        const cutoff = beforeDate ?? new Date(Date.now() - COMPACTION_AGE_DAYS * 86400000).toISOString().slice(0, 10);
        const index: JournalIndex = await readJsonSafe(INDEX_PATH);
        
        const oldEntries = index.entries.filter(e => !e.compacted && e.date < cutoff);
        if (oldEntries.length === 0) return { compacted: 0, summary: '' };

        const summaries: string[] = [];
        let compacted = 0;

        for (const meta of oldEntries) {
            const entryPath = path.join(ENTRIES_DIR, `${meta.date}-${meta.id}.md`);
            try {
                const raw = await fs.readFile(entryPath, 'utf8');
                const decrypted = await this.decryptEntryContent(raw);
                const entry = this.parseEntry(decrypted, meta);
                
                // Generate compact summary
                const summary = this.generateCompactSummary(entry);
                summaries.push(summary);
                
                // Mark as compacted in index
                meta.compacted = true;
                compacted++;
            } catch { /* skip broken entries */ }
        }

        // Write compaction file
        const compactPath = path.join(COMPACTED_DIR, `compact-${cutoff}.md`);
        const compactMd = `# Compacted Entries — Before ${cutoff}\n\n` +
            `> Auto-generated ${new Date().toISOString()}\n> ${compacted} entries compacted\n\n` +
            summaries.join('\n---\n\n');
        await fs.writeFile(compactPath, compactMd, 'utf8');

        // Update index
        index.last_updated = Date.now();
        await writeJsonSafe(INDEX_PATH, index);

        return { compacted, summary: compactMd.slice(0, 2000) };
    }

    // ── Stats ──

    async getStats(): Promise<JournalStats> {
        await this.ensureInit();
        const index: JournalIndex = await readJsonSafe(INDEX_PATH);
        const entries = index.entries;
        const now = today();

        const thisWeek = entries.filter(e => daysAgo(e.date) <= 7);
        const thisMonth = entries.filter(e => daysAgo(e.date) <= 30);
        const todayEntries = entries.filter(e => e.date === now);

        // Read all entries for metrics
        let totalDecisions = 0;
        let longestMin = 0;
        let totalMin = 0;
        let minCount = 0;
        const wsCounts = new Map<string, number>();
        const tagCounts = new Map<string, number>();

        // Sample recent entries for stats
        const recent = entries.slice(-30);
        for (const meta of recent) {
            const entryPath = path.join(ENTRIES_DIR, `${meta.date}-${meta.id}.md`);
            try {
                const raw = await fs.readFile(entryPath, 'utf8');
                const decrypted = await this.decryptEntryContent(raw);
                const entry = this.parseEntry(decrypted, meta);
                totalDecisions += entry.decisions.length;
                if (entry.metrics.session_duration_min > 0) {
                    totalMin += entry.metrics.session_duration_min;
                    minCount++;
                    if (entry.metrics.session_duration_min > longestMin) {
                        longestMin = entry.metrics.session_duration_min;
                    }
                }
                wsCounts.set(meta.workspace, (wsCounts.get(meta.workspace) ?? 0) + 1);
                for (const tag of meta.tags) {
                    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
                }
            } catch {}
        }

        const mostActive = [...wsCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none';
        const recentTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
        const todayMinutes = todayEntries.length * (minCount > 0 ? Math.round(totalMin / minCount) : 30);

        return {
            total_entries: entries.length,
            total_decisions: totalDecisions,
            entries_this_week: thisWeek.length,
            entries_this_month: thisMonth.length,
            longest_session_min: longestMin,
            avg_session_min: minCount > 0 ? Math.round(totalMin / minCount) : 0,
            most_active_workspace: mostActive,
            recent_tags: recentTags,
            wellness: {
                sessions_today: todayEntries.length,
                total_minutes_today: todayMinutes,
                flag_long_session: todayMinutes > 240,
            },
        };
    }

    // ── Search ──

    async search(query: string, limit: number = 10): Promise<{ id: string; date: string; title: string; snippet: string }[]> {
        await this.ensureInit();
        const index: JournalIndex = await readJsonSafe(INDEX_PATH);
        const q = query.toLowerCase();
        const results: { id: string; date: string; title: string; snippet: string }[] = [];

        for (const meta of [...index.entries].reverse()) {
            if (results.length >= limit) break;
            const entryPath = path.join(ENTRIES_DIR, `${meta.date}-${meta.id}.md`);
            try {
                const raw = await fs.readFile(entryPath, 'utf8');
                const decrypted = await this.decryptEntryContent(raw);
                const lower = decrypted.toLowerCase();
                if (lower.includes(q)) {
                    const idx = lower.indexOf(q);
                    const start = Math.max(0, idx - 60);
                    const end = Math.min(decrypted.length, idx + q.length + 60);
                    results.push({
                        id: meta.id,
                        date: meta.date,
                        title: meta.title,
                        snippet: (start > 0 ? '...' : '') + decrypted.slice(start, end).replace(/\n/g, ' ') + (end < decrypted.length ? '...' : ''),
                    });
                }
            } catch {}
        }
        return results;
    }

    // ── Context Injection (for system prompt) ──

    async getContextInjection(maxEntries: number = 3, maxChars: number = 2000): Promise<string> {
        await this.ensureInit();
        const recent = await this.readRecent(maxEntries);
        if (recent.length === 0) return '';

        const lines: string[] = ['## 📔 Conductor\'s Journal — Recent Sessions'];
        let totalChars = 0;

        for (const entry of recent) {
            const header = `### ${entry.date} — ${entry.title} (${entry.workspace_name})`;
            const decisions = entry.decisions.length > 0
                ? `Decisions: ${entry.decisions.map(d => d.decision).join('; ')}`
                : '';
            const metrics = `Metrics: ${entry.metrics.commits} commits, ${entry.metrics.tool_calls_approx} tool calls, ~${entry.metrics.session_duration_min}min`;
            const block = `${header}\n${decisions}\n${metrics}\n`;
            if (totalChars + block.length > maxChars) break;
            lines.push(block);
            totalChars += block.length;
        }
        if (totalChars === 0) return '';
        return lines.join('\n') + '\n---\n';
    }

    // ── Encryption wrappers for entry content ──
    
    private async encryptEntryContent(md: string): Promise<string> {
        const contentMarker = '\n## Content\n\n';
        const idx = md.indexOf(contentMarker);
        if (idx === -1) {
            return `🔒ENCRYPTED:${await encryptContent(md)}`;
        }
        const headerPart = md.slice(0, idx + contentMarker.length);
        const contentPart = md.slice(idx + contentMarker.length);
        return headerPart + `🔒ENCRYPTED:${await encryptContent(contentPart)}`;
    }
    
    private async decryptEntryContent(raw: string): Promise<string> {
        const contentMarker = '\n## Content\n\n';
        const idx = raw.indexOf(contentMarker);
        if (idx === -1) {
            if (raw.startsWith('🔒ENCRYPTED:')) {
                return (await decryptContent(raw.slice('🔒ENCRYPTED:'.length))) ?? raw;
            }
            return raw;
        }
        const headerPart = raw.slice(0, idx + contentMarker.length);
        const afterMarker = raw.slice(idx + contentMarker.length);
        if (afterMarker.startsWith('🔒ENCRYPTED:')) {
            return headerPart + ((await decryptContent(afterMarker.slice('🔒ENCRYPTED:'.length))) ?? afterMarker);
        }
        return raw;
    }

    // ── Internal Formatting ──

    private formatEntry(entry: JournalEntry): string {
        const lines: string[] = [];
        lines.push(`# ${entry.title}`);
        lines.push('');
        lines.push(`> **Date:** ${entry.date} | **Workspace:** ${entry.workspace_name} | **Branch:** ${entry.branch}`);
        lines.push(`> **ID:** ${entry.id} | **Tags:** ${entry.tags.join(', ') || 'none'}`);
        lines.push('');
        
        if (entry.decisions.length > 0) {
            lines.push('## Decisions');
            lines.push('');
            for (const d of entry.decisions) {
                lines.push(`- **${d.decision}**`);
                lines.push(`  - Rationale: ${d.rationale}`);
                if (d.alternatives.length > 0) {
                    lines.push(`  - Alternatives considered: ${d.alternatives.join(', ')}`);
                }
            }
            lines.push('');
        }

        lines.push('## Session Metrics');
        lines.push('');
        lines.push(`| Metric | Value |`);
        lines.push(`|:---|---:|`);
        lines.push(`| Commits | ${entry.metrics.commits} |`);
        lines.push(`| Files changed | ${entry.metrics.files_changed} |`);
        lines.push(`| Tool calls (approx) | ${entry.metrics.tool_calls_approx} |`);
        lines.push(`| Duration | ~${entry.metrics.session_duration_min} min |`);
        lines.push(`| Todos completed | ${entry.metrics.todos_completed} |`);
        lines.push(`| Todos pending | ${entry.metrics.todos_pending} |`);
        lines.push('');

        lines.push('## Content');
        lines.push('');
        lines.push(entry.content);
        lines.push('');

        return lines.join('\n');
    }

    private parseEntry(raw: string, meta: { id: string; date: string; title: string; tags: string[]; compacted: boolean }): JournalEntry {
        const decisions: JournalDecision[] = [];
        const metrics: JournalMetrics = { commits: 0, files_changed: 0, tool_calls_approx: 0, session_duration_min: 0, todos_completed: 0, todos_pending: 0 };
        let content = raw;
        let workspace = 'unknown';
        let branch = 'unknown';
        let workspaceName = 'unknown';

        // Extract workspace and branch from header
        const headerMatch = raw.match(/\*\*Workspace:\*\*\s*(.+?)\s*\|\s*\*\*Branch:\*\*\s*(.+?)\s*\n/);
        if (headerMatch) {
            workspaceName = headerMatch[1].trim();
            branch = headerMatch[2].trim();
            workspace = workspaceName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
        }

        // Extract decisions
        const decisionSection = raw.match(/## Decisions\n\n([\s\S]*?)(?=\n## |$)/);
        if (decisionSection) {
            const items = decisionSection[1].match(/- \*\*(.+?)\*\*\n\s+- Rationale: (.+?)(?:\n\s+- Alternatives considered: (.+?))?(?=\n-|$)/g);
            if (items) {
                for (const item of items) {
                    const dMatch = item.match(/- \*\*(.+?)\*\*\n\s+- Rationale: (.+?)(?:\n\s+- Alternatives considered: (.+))?$/s);
                    if (dMatch) {
                        decisions.push({
                            decision: dMatch[1].trim(),
                            rationale: dMatch[2].trim(),
                            alternatives: dMatch[3] ? dMatch[3].split(',').map(s => s.trim()) : [],
                            timestamp: Date.now(),
                        });
                    }
                }
            }
        }

        // Extract metrics
        const metricsSection = raw.match(/\| Commits \| (\d+)/);
        if (metricsSection) metrics.commits = parseInt(metricsSection[1]);
        const filesMatch = raw.match(/\| Files changed \| (\d+)/);
        if (filesMatch) metrics.files_changed = parseInt(filesMatch[1]);
        const toolsMatch = raw.match(/\| Tool calls \(approx\) \| (\d+)/);
        if (toolsMatch) metrics.tool_calls_approx = parseInt(toolsMatch[1]);
        const durMatch = raw.match(/\| Duration \| ~(\d+)/);
        if (durMatch) metrics.session_duration_min = parseInt(durMatch[1]);
        const doneMatch = raw.match(/\| Todos completed \| (\d+)/);
        if (doneMatch) metrics.todos_completed = parseInt(doneMatch[1]);
        const pendMatch = raw.match(/\| Todos pending \| (\d+)/);
        if (pendMatch) metrics.todos_pending = parseInt(pendMatch[1]);

        // Extract content (everything after ## Content)
        const contentMatch = raw.match(/## Content\n\n([\s\S]*)/);
        if (contentMatch) content = contentMatch[1].trim();

        return {
            id: meta.id,
            timestamp: Date.now(),
            date: meta.date,
            workspace,
            workspace_name: workspaceName,
            branch,
            title: meta.title,
            content,
            decisions,
            metrics,
            tags: meta.tags,
            compacted: meta.compacted,
        };
    }

    private generateCompactSummary(entry: JournalEntry): string {
        const decisions = entry.decisions.map(d => `  - ${d.decision}`).join('\n');
        return `### ${entry.date} — ${entry.title}\n` +
            `**Workspace:** ${entry.workspace_name} | **Branch:** ${entry.branch} | **Tags:** ${entry.tags.join(', ')}\n\n` +
            (decisions ? `**Key Decisions:**\n${decisions}\n\n` : '') +
            `**Metrics:** ${entry.metrics.commits} commits, ~${entry.metrics.session_duration_min}min, ${entry.metrics.todos_completed}/${entry.metrics.todos_pending + entry.metrics.todos_completed} todos\n\n` +
            `**Summary:** ${entry.content.slice(0, 300)}${entry.content.length > 300 ? '...' : ''}`;
    }
}
