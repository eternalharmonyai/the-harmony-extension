/**
 * Mnemosyne Migration: JSONL → DuckDB
 * 
 * Migrates legacy episodic memory data from .harmony/episodic-memory/memories.jsonl
 * to the new DuckDB backend (.harmony/episodic-memory/harmony.db).
 * 
 * Usage: node scripts/migrate-mnemosyne.js [workspace-root]
 * 
 * Safety:
 *   - Creates a backup of the JSONL before migration
 *   - Idempotent — skips already-migrated entries
 *   - Reports counts: migrated, skipped, errors
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { EpisodicStore, MemoryEntry } from '../src/episodicStore';

function uid(): string { return crypto.randomUUID().slice(0, 8); }

interface LegacyEntry {
    id?: string;
    content: string;
    tags?: string[];
    confidence?: number;
    related_ids?: string[];
    source?: string;
    timestamp?: number;
    created_at?: string;
}

async function main() {
    const workspaceRoot = process.argv[2] || process.cwd();
    console.log(`🔍 Mnemosyne Migration: JSONL → DuckDB`);
    console.log(`   Workspace: ${workspaceRoot}`);
    
    const memoryDir = path.join(workspaceRoot, '.harmony', 'episodic-memory');
    const jsonlPath = path.join(memoryDir, 'memories.jsonl');
    const dbPath = path.join(memoryDir, 'harmony.db');
    
    // Check if JSONL exists
    try {
        await fs.access(jsonlPath);
    } catch {
        console.log('✅ No JSONL file found — nothing to migrate.');
        return;
    }
    
    // Read legacy entries
    const raw = await fs.readFile(jsonlPath, 'utf8');
    if (!raw.trim()) {
        console.log('✅ JSONL file is empty — nothing to migrate.');
        return;
    }
    
    const lines = raw.trim().split('\n');
    const legacyEntries: LegacyEntry[] = [];
    for (const line of lines) {
        try {
            legacyEntries.push(JSON.parse(line));
        } catch {
            console.warn(`⚠️  Skipping malformed line: ${line.slice(0, 80)}...`);
        }
    }
    
    console.log(`📦 Found ${legacyEntries.length} legacy entries in JSONL.`);
    
    // Backup JSONL
    const backupPath = jsonlPath + `.backup-${Date.now()}`;
    await fs.copyFile(jsonlPath, backupPath);
    console.log(`💾 Backup created: ${backupPath}`);
    
    // Initialize DuckDB store
    const store = new EpisodicStore(workspaceRoot);
    await store.init();
    
    // Check existing entries in DuckDB (for idempotency)
    let migrated = 0;
    let skipped = 0;
    let errors = 0;
    
    for (const entry of legacyEntries) {
        try {
            if (!entry.content || entry.content.trim().length === 0) {
                skipped++;
                continue;
            }
            
            // Migrate: use content as unique key for dedup
            // EpisodicStore.store() already does this
            const result = await store.store({
                content: entry.content,
                tags: entry.tags ?? [],
                confidence: entry.confidence ?? 0.5,
                related_ids: entry.related_ids ?? [],
                source: entry.source ?? 'migration',
            });
            
            if (result.status === 'skipped') {
                skipped++;
            } else {
                migrated++;
            }
        } catch (e: any) {
            errors++;
            console.warn(`⚠️  Error migrating entry: ${e.message?.slice(0, 100)}`);
        }
    }
    
    // Report
    console.log(`\n📊 Migration Complete:`);
    console.log(`   ✅ Migrated: ${migrated}`);
    console.log(`   ⏭️  Skipped (duplicates): ${skipped}`);
    console.log(`   ❌ Errors: ${errors}`);
    console.log(`   📁 Backup: ${backupPath}`);
    console.log(`   🗄️  DuckDB: ${dbPath}`);
    
    if (migrated > 0) {
        console.log(`\n💡 Tip: Keep the backup (${path.basename(backupPath)}) until you've verified DuckDB data.`);
    }
}

main().catch(err => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
});
