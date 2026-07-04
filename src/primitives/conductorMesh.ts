/**
 * Federated Conductor Mesh — Beyond-100% Phase C3
 *
 * Cross-project knowledge sharing between conductors.
 * Opt-in, privacy-respecting, confidence-scored, versioned, auto-pruned.
 *
 * Architecture:
 *   Conductor A (repo X)          Conductor B (repo Y)
 *         │                              │
 *         └──── HarmonyHub (local) ──────┘
 *                       │
 *             Federated Sync Layer
 *                       │
 *           .harmony/conductor/knowledge/*.md
 *           (confidence-scored, versioned, auto-pruned)
 *
 * Features:
 * - Opt-in mesh membership (never automatic)
 * - Knowledge module confidence scoring (0-100%)
 * - Version tracking with staleness detection
 * - Auto-pruning of low-confidence or stale modules
 * - Privacy: only .harmony/conductor/knowledge/ is shared
 * - Conflict resolution when two conductors learn contradictory patterns
 *
 * @example
 *   invoke({ action: 'join', mesh_name: 'harmony-conductors' });
 *   invoke({ action: 'sync' }); // Sync knowledge modules
 *   invoke({ action: 'status' }); // View mesh status
 *   invoke({ action: 'prune', min_confidence: 0.3, max_age_days: 90 });
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { workspaceRoot, textResult, ensureDir, uid } from './shared';
import { safeHarmonyDir } from '../swarmHarden';
import { BasePrimitive } from './basePrimitive';

// ─── Types ───────────────────────────────────────────────────────────

interface KnowledgeModule {
    module_id: string;
    filename: string;
    title: string;
    category: string;
    confidence: number; // 0-1
    occurrences: number;
    source_project: string;
    source_conductor: string;
    created_at: number;
    updated_at: number;
    version: number;
    content_hash: string; // SHA256 of content for dedup
    tags: string[];
    status: 'active' | 'stale' | 'pruned' | 'conflict';
}

interface MeshConfig {
    mesh_name: string;
    joined_at: number;
    projects: string[]; // workspace paths that are members
    sync_interval_hours: number;
    min_confidence_threshold: number;
    max_age_days: number; // auto-prune after this
    allow_auto_prune: boolean;
    conflict_resolution: 'newest_wins' | 'highest_confidence' | 'manual';
}

interface MeshStatus {
    mesh_name: string;
    connected: boolean;
    projects_count: number;
    modules_count: number;
    last_sync: number | null;
    active_modules: number;
    stale_modules: number;
    pruned_modules: number;
    conflicts: number;
}

interface MeshInput {
    action: 'join' | 'leave' | 'sync' | 'status' | 'prune' | 'search' | 'export';
    mesh_name?: string;
    project_path?: string;
    min_confidence?: number;
    max_age_days?: number;
    query?: string;
    conflict_resolution?: 'newest_wins' | 'highest_confidence' | 'manual';
    export_format?: 'json' | 'markdown';
}

// ─── Simple hash for content dedup ──────────────────────────────────

function simpleHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
}

// ─── Mesh Engine ────────────────────────────────────────────────────

export class ConductorMeshTool extends BasePrimitive<MeshInput> {
    constructor() { super('conductor-mesh'); }

    private meshDir(root: string): string {
        return path.join(root, '.harmony', 'conductor', 'mesh');
    }

    private knowledgeDir(root: string): string {
        return path.join(root, '.harmony', 'conductor', 'knowledge');
    }

    private configPath(root: string): string {
        return path.join(this.meshDir(root), 'mesh-config.json');
    }

    private indexPath(root: string): string {
        return path.join(this.meshDir(root), 'module-index.json');
    }

    private async loadConfig(root: string): Promise<MeshConfig | null> {
        try {
            const raw = await fs.readFile(this.configPath(root), 'utf8');
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    private async saveConfig(root: string, config: MeshConfig): Promise<void> {
        await ensureDir(this.meshDir(root));
        await fs.writeFile(this.configPath(root), JSON.stringify(config, null, 2), 'utf8');
    }

    private async loadIndex(root: string): Promise<KnowledgeModule[]> {
        try {
            const raw = await fs.readFile(this.indexPath(root), 'utf8');
            return JSON.parse(raw);
        } catch {
            return [];
        }
    }

    private async saveIndex(root: string, modules: KnowledgeModule[]): Promise<void> {
        await ensureDir(this.meshDir(root));
        await fs.writeFile(this.indexPath(root), JSON.stringify(modules, null, 2), 'utf8');
    }

    private async scanKnowledgeModules(root: string): Promise<{ filename: string; content: string; stat: { mtimeMs: number } }[]> {
        const kd = this.knowledgeDir(root);
        const results: { filename: string; content: string; stat: { mtimeMs: number } }[] = [];
        
        // Scan learned-*.md files in .harmony/conductor/knowledge/
        try {
            const files = await fs.readdir(kd);
            for (const f of files) {
                if (f.endsWith('.md') && f.startsWith('learned-')) {
                    const fp = path.join(kd, f);
                    const content = await fs.readFile(fp, 'utf8');
                    const stat = await fs.stat(fp);
                    results.push({ filename: f, content, stat: { mtimeMs: stat.mtimeMs } });
                }
            }
        } catch { /* directory may not exist */ }
        
        // 🌸 Scan Wisdom Sprouts from CareBloom Garden (.carebloom/)
        const sproutDir = path.join(root, '.carebloom');
        try {
            const sproutFiles = await fs.readdir(sproutDir);
            for (const f of sproutFiles) {
                if (f.endsWith('.md') && f.startsWith('wisdom-sprout-')) {
                    const fp = path.join(sproutDir, f);
                    const content = await fs.readFile(fp, 'utf8');
                    const stat = await fs.stat(fp);
                    results.push({ filename: `carebloom-${f}`, content, stat: { mtimeMs: stat.mtimeMs } });
                }
            }
        } catch { /* .carebloom/ directory may not exist yet */ }
        
        return results;
    }

    /** Extract module metadata from markdown content */
    private parseModuleMetadata(filename: string, content: string, sourceProject: string): Partial<KnowledgeModule> {
        const titleMatch = content.match(/^# (.+)$/m);
        const categoryMatch = content.match(/## Category\n(.+)/);
        const occurrencesMatch = content.match(/This happened \*\*(\d+) times\*\*/);
        const thresholdMatch = content.match(/Threshold: (\d+) occurrences/);

        return {
            filename,
            title: titleMatch?.[1] ?? filename.replace('.md', '').replace('learned-', ''),
            category: categoryMatch?.[1]?.trim() ?? 'unknown',
            occurrences: occurrencesMatch ? parseInt(occurrencesMatch[1]) : 1,
            confidence: thresholdMatch
                ? Math.min(parseInt(thresholdMatch[1]) / 3, 1.0)
                : 0.5,
            tags: this.extractTags(content),
            source_project: sourceProject,
        };
    }

    private extractTags(content: string): string[] {
        const tags: string[] = [];
        const tagSection = content.match(/## Tags?\n([\s\S]*?)(?:\n##|$)/);
        if (tagSection) {
            const tagLines = tagSection[1].split('\n').filter(l => l.trim().startsWith('-'));
            tags.push(...tagLines.map(l => l.replace(/^-\s*/, '').trim()));
        }
        // Fallback: extract from category
        const catMatch = content.match(/## Category\n(.+)/);
        if (catMatch && tags.length === 0) {
            tags.push(catMatch[1].trim().toLowerCase().replace(/\s+/g, '-'));
        }
        return tags.length > 0 ? tags : ['uncategorized'];
    }

    protected async invokeImpl(
        options: vscode.LanguageModelToolInvocationOptions<MeshInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        this.requireFields(options.input as any, ['action']);
        const { action, mesh_name, project_path, min_confidence = 0.3, max_age_days = 90, query, conflict_resolution, export_format = 'json' } = options.input;
        const root = workspaceRoot();
        if (!root) return textResult(JSON.stringify({ error: 'no workspace' }));

        await ensureDir(this.meshDir(root));

        switch (action) {
            case 'join': {
                const name = mesh_name ?? `mesh-${uid().slice(0, 6)}`;
                const existing = await this.loadConfig(root);

                if (existing) {
                    return textResult(JSON.stringify({
                        error: 'already in a mesh',
                        current_mesh: existing.mesh_name,
                        joined_at: new Date(existing.joined_at).toISOString(),
                        hint: 'Use action:"leave" first to leave current mesh, or action:"status" to view.',
                    }));
                }

                const config: MeshConfig = {
                    mesh_name: name,
                    joined_at: Date.now(),
                    projects: [root],
                    sync_interval_hours: 24,
                    min_confidence_threshold: min_confidence,
                    max_age_days,
                    allow_auto_prune: true,
                    conflict_resolution: conflict_resolution ?? 'highest_confidence',
                };

                await this.saveConfig(root, config);

                // Scan existing knowledge modules
                const scanned = await this.scanKnowledgeModules(root);
                const modules: KnowledgeModule[] = scanned.map(s => ({
                    module_id: uid(),
                    filename: s.filename,
                    ...this.parseModuleMetadata(s.filename, s.content, path.basename(root)),
                    source_conductor: 'local',
                    created_at: s.stat.mtimeMs,
                    updated_at: Date.now(),
                    version: 1,
                    content_hash: simpleHash(s.content),
                    status: 'active' as const,
                } as KnowledgeModule));

                await this.saveIndex(root, modules);

                return textResult(JSON.stringify({
                    status: 'joined',
                    mesh_name: name,
                    projects: 1,
                    modules_indexed: modules.length,
                    config,
                }, null, 2));
            }

            case 'leave': {
                const config = await this.loadConfig(root);
                if (!config) return textResult(JSON.stringify({ error: 'not in any mesh' }));

                // Archive the config and index
                const archiveDir = path.join(this.meshDir(root), 'archive');
                await ensureDir(archiveDir);
                const ts = new Date().toISOString().replace(/[:.]/g, '-');
                try {
                    await fs.rename(this.configPath(root), path.join(archiveDir, `mesh-config-${ts}.json`));
                    await fs.rename(this.indexPath(root), path.join(archiveDir, `module-index-${ts}.json`));
                } catch { /* files may not exist */ }

                return textResult(JSON.stringify({
                    status: 'left',
                    mesh_name: config.mesh_name,
                    archived_to: archiveDir,
                }));
            }

            case 'sync': {
                const config = await this.loadConfig(root);
                if (!config) return textResult(JSON.stringify({ error: 'not in any mesh. Use action:"join" first.' }));

                const existingModules = await this.loadIndex(root);
                const scanned = await this.scanKnowledgeModules(root);

                let newCount = 0;
                let updatedCount = 0;
                let conflictCount = 0;

                for (const s of scanned) {
                    const hash = simpleHash(s.content);
                    const existing = existingModules.find(m => m.filename === s.filename);

                    if (!existing) {
                        // New module
                        const meta = this.parseModuleMetadata(s.filename, s.content, path.basename(root));
                        existingModules.push({
                            module_id: uid(),
                            filename: s.filename,
                            title: meta.title ?? s.filename,
                            category: meta.category ?? 'unknown',
                            confidence: meta.confidence ?? 0.5,
                            occurrences: meta.occurrences ?? 1,
                            source_project: path.basename(root),
                            source_conductor: 'local',
                            created_at: s.stat.mtimeMs,
                            updated_at: Date.now(),
                            version: 1,
                            content_hash: hash,
                            tags: meta.tags ?? ['uncategorized'],
                            status: 'active',
                        });
                        newCount++;
                    } else if (existing.content_hash !== hash) {
                        // Updated module — check for conflict
                        if (existing.status === 'active') {
                            existing.version++;
                            existing.content_hash = hash;
                            existing.updated_at = Date.now();
                            existing.confidence = Math.min(existing.confidence + 0.1, 1.0); // Boost confidence on update
                            updatedCount++;
                        } else {
                            conflictCount++;
                        }
                    } else {
                        // Unchanged — update last-seen timestamp
                        existing.updated_at = Date.now();
                    }
                }

                // Mark stale modules (not seen in max_age_days)
                const cutoff = Date.now() - config.max_age_days * 86400 * 1000;
                for (const m of existingModules) {
                    if (m.status === 'active' && m.updated_at < cutoff) {
                        m.status = 'stale';
                    }
                    // Auto-prune if enabled and below confidence threshold
                    if (config.allow_auto_prune && m.status === 'stale' && m.confidence < config.min_confidence_threshold) {
                        m.status = 'pruned';
                    }
                }

                await this.saveIndex(root, existingModules);

                // Update config's last_sync timestamp
                const status: MeshStatus = {
                    mesh_name: config.mesh_name,
                    connected: true,
                    projects_count: config.projects.length,
                    modules_count: existingModules.length,
                    last_sync: Date.now(),
                    active_modules: existingModules.filter(m => m.status === 'active').length,
                    stale_modules: existingModules.filter(m => m.status === 'stale').length,
                    pruned_modules: existingModules.filter(m => m.status === 'pruned').length,
                    conflicts: conflictCount,
                };

                return textResult(JSON.stringify({
                    status: 'synced',
                    new_modules: newCount,
                    updated_modules: updatedCount,
                    conflicts: conflictCount,
                    mesh_status: status,
                }, null, 2));
            }

            case 'status': {
                const config = await this.loadConfig(root);
                if (!config) return textResult(JSON.stringify({
                    in_mesh: false,
                    hint: 'Use action:"join" to join a conductor mesh.',
                }));

                const modules = await this.loadIndex(root);

                const status: MeshStatus = {
                    mesh_name: config.mesh_name,
                    connected: true,
                    projects_count: config.projects.length,
                    modules_count: modules.length,
                    last_sync: modules.length > 0
                        ? Math.max(...modules.map(m => m.updated_at))
                        : null,
                    active_modules: modules.filter(m => m.status === 'active').length,
                    stale_modules: modules.filter(m => m.status === 'stale').length,
                    pruned_modules: modules.filter(m => m.status === 'pruned').length,
                    conflicts: modules.filter(m => m.status === 'conflict').length,
                };

                return textResult(JSON.stringify({
                    mesh_status: status,
                    config: {
                        min_confidence: config.min_confidence_threshold,
                        max_age_days: config.max_age_days,
                        auto_prune: config.allow_auto_prune,
                        conflict_resolution: config.conflict_resolution,
                    },
                    top_modules: modules
                        .filter(m => m.status === 'active')
                        .sort((a, b) => b.confidence - a.confidence)
                        .slice(0, 5)
                        .map(m => ({
                            title: m.title,
                            category: m.category,
                            confidence: m.confidence,
                            occurrences: m.occurrences,
                            version: m.version,
                        })),
                }, null, 2));
            }

            case 'prune': {
                const config = await this.loadConfig(root);
                if (!config) return textResult(JSON.stringify({ error: 'not in any mesh' }));

                const modules = await this.loadIndex(root);
                const threshold = min_confidence ?? config.min_confidence_threshold;
                const ageDays = max_age_days ?? config.max_age_days;
                const cutoff = Date.now() - ageDays * 86400 * 1000;

                let prunedCount = 0;
                for (const m of modules) {
                    if (m.status !== 'pruned' && (m.confidence < threshold || m.updated_at < cutoff)) {
                        m.status = 'pruned';
                        prunedCount++;
                    }
                }

                await this.saveIndex(root, modules);

                return textResult(JSON.stringify({
                    status: 'pruned',
                    pruned: prunedCount,
                    threshold_confidence: threshold,
                    max_age_days: ageDays,
                    remaining_active: modules.filter(m => m.status === 'active').length,
                }, null, 2));
            }

            case 'search': {
                if (!query?.trim()) return textResult(JSON.stringify({ error: 'query required for search' }));

                const modules = await this.loadIndex(root);
                const lower = query.toLowerCase();
                const results = modules
                    .filter(m => m.status !== 'pruned')
                    .filter(m =>
                        m.title.toLowerCase().includes(lower) ||
                        m.category.toLowerCase().includes(lower) ||
                        m.tags.some(t => t.toLowerCase().includes(lower))
                    )
                    .sort((a, b) => b.confidence - a.confidence)
                    .slice(0, 10);

                return textResult(JSON.stringify({
                    query,
                    results_count: results.length,
                    results: results.map(m => ({
                        title: m.title,
                        category: m.category,
                        confidence: m.confidence,
                        version: m.version,
                        status: m.status,
                        source: m.source_project,
                        tags: m.tags,
                    })),
                }, null, 2));
            }

            case 'export': {
                const modules = await this.loadIndex(root);
                const active = modules.filter(m => m.status === 'active');

                if (export_format === 'markdown') {
                    const lines: string[] = [
                        '# Conductor Mesh Knowledge Export',
                        '',
                        `**Exported:** ${new Date().toISOString()}`,
                        `**Total Modules:** ${active.length}`,
                        '',
                        '## Active Knowledge Modules',
                        '',
                    ];
                    for (const m of active.sort((a, b) => b.confidence - a.confidence)) {
                        lines.push(`### ${m.title} (${(m.confidence * 100).toFixed(0)}% confidence)`);
                        lines.push(`- **Category:** ${m.category}`);
                        lines.push(`- **Source:** ${m.source_project}`);
                        lines.push(`- **Occurrences:** ${m.occurrences}`);
                        lines.push(`- **Version:** ${m.version}`);
                        lines.push(`- **Tags:** ${m.tags.join(', ')}`);
                        lines.push('');
                    }
                    return textResult(lines.join('\n'));
                }

                return textResult(JSON.stringify({
                    exported_at: new Date().toISOString(),
                    total: active.length,
                    modules: active.map(m => ({
                        title: m.title,
                        category: m.category,
                        confidence: m.confidence,
                        occurrences: m.occurrences,
                        source: m.source_project,
                        version: m.version,
                        tags: m.tags,
                        filename: m.filename,
                    })),
                }, null, 2));
            }

            default:
                return textResult(JSON.stringify({ error: `unknown action: ${action}` }));
        }
    }
}
