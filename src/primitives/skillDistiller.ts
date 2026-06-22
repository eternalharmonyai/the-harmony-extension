/**
 * Skill Distiller (Crucible) — DuckDB-backed skill crystal store.
 *
 * 100% upgrade: DuckDB replaces JSONL for concurrent-write safety.
 *   - Shared DuckDB connection via getSharedDuckDB
 *   - Parameterized queries prevent SQL injection
 *   - Atomic INSERT + indexed queries for scale
 *
 * @example
 *   invoke({ action: 'extract', name: 'retry-pattern', solution_pattern: '...' });
 *   invoke({ action: 'query', query_language: 'typescript', limit: 10 });
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { workspaceRoot, textResult, uid } from './shared';
import { getSharedDuckDB } from '../storageUtils';
import { idempotent } from '../storageUtils';
import { BasePrimitive } from './basePrimitive';

interface SkillCrystal { id: string; name: string; description: string; preconditions: string[]; invariants: string[]; failure_modes: string[]; solution_pattern: string; language: string; extracted_from: string; timestamp: number; }
interface SkillDistillerInput { action: 'extract' | 'query' | 'load' | 'stats'; name?: string; description?: string; preconditions?: string[]; invariants?: string[]; failure_modes?: string[]; solution_pattern?: string; language?: string; extracted_from?: string; query_language?: string; query_name?: string; limit?: number; }

// ── DuckDB helpers ──
function dbRun(db: any, sql: string, ...params: any[]): Promise<void> {
    return new Promise((resolve, reject) => {
        db.run(sql, ...params, (err: any) => err ? reject(err) : resolve());
    });
}
function dbAll(db: any, sql: string, ...params: any[]): Promise<any[]> {
    return new Promise((resolve, reject) => {
        db.all(sql, ...params, (err: any, rows: any[]) => err ? reject(err) : resolve(rows));
    });
}

// ── Schema init (idempotent) ──
async function ensureSchema(db: any): Promise<void> {
    await dbRun(db, `
        CREATE TABLE IF NOT EXISTS skill_crystals (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            preconditions TEXT DEFAULT '[]',
            invariants TEXT DEFAULT '[]',
            failure_modes TEXT DEFAULT '[]',
            solution_pattern TEXT NOT NULL,
            language TEXT DEFAULT 'typescript',
            extracted_from TEXT DEFAULT 'unknown',
            timestamp BIGINT NOT NULL
        )
    `);
    await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_sc_language ON skill_crystals(language)`);
    await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_sc_name ON skill_crystals(name)`);
    await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_sc_timestamp ON skill_crystals(timestamp)`);
}

export class SkillDistillerTool extends BasePrimitive<SkillDistillerInput> {
    constructor() { super('skill-distiller'); }

    protected async invokeImpl(options: vscode.LanguageModelToolInvocationOptions<SkillDistillerInput>, _token: vscode.CancellationToken) {
        const fieldErr = this.requireFields(options.input as any, ['action']);
        if (fieldErr) return textResult(JSON.stringify({ error: fieldErr }));
        const { action, name, description, preconditions, invariants, failure_modes, solution_pattern, language = 'typescript', extracted_from, query_language, query_name, limit = 20 } = options.input;
        const root = workspaceRoot(); if (!root) return textResult(JSON.stringify({ error: 'no workspace' }));
        const db = await getSharedDuckDB(root);
        if (!db) return textResult(JSON.stringify({ error: 'DuckDB unavailable — falling back to JSONL (not implemented)' }));
        await ensureSchema(db);
        switch (action) {
            case 'extract': {
                if (!name || !solution_pattern) return textResult(JSON.stringify({ error: 'name and solution_pattern required' }));
                const key = crypto.createHash('sha256').update(JSON.stringify({ name, solution_pattern, language })).digest('hex').slice(0, 16);
                return await idempotent(`crucible:${key}`, async () => {
                    const crystal: SkillCrystal = { id: uid(), name, description: description ?? '', preconditions: preconditions ?? [], invariants: invariants ?? [], failure_modes: failure_modes ?? [], solution_pattern, language, extracted_from: extracted_from ?? 'unknown', timestamp: Date.now() };
                    await dbRun(db,
                        `INSERT INTO skill_crystals (id, name, description, preconditions, invariants, failure_modes, solution_pattern, language, extracted_from, timestamp)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        crystal.id, crystal.name, crystal.description, JSON.stringify(crystal.preconditions), JSON.stringify(crystal.invariants),
                        JSON.stringify(crystal.failure_modes), crystal.solution_pattern, crystal.language, crystal.extracted_from, crystal.timestamp
                    );
                    return textResult(JSON.stringify({ status: 'extracted', id: crystal.id, name, language, preconditions: crystal.preconditions.length }, null, 2));
                });
            }
            case 'query': {
                let sql = `SELECT id, name, language, description, timestamp FROM skill_crystals WHERE 1=1`;
                const params: any[] = [];
                if (query_language) { sql += ` AND language = ?`; params.push(query_language); }
                if (query_name) { sql += ` AND name LIKE ?`; params.push(`%${query_name}%`); }
                sql += ` ORDER BY timestamp DESC LIMIT ?`; params.push(limit);
                const rows = await dbAll(db, sql, ...params);
                return textResult(JSON.stringify({ count: rows.length, crystals: rows.map((r: any) => ({ id: r.id, name: r.name, language: r.language, description: (r.description ?? '').slice(0, 150) })) }, null, 2));
            }
            case 'load': {
                if (!query_name) return textResult(JSON.stringify({ error: 'query_name required' }));
                const rows = await dbAll(db, `SELECT * FROM skill_crystals WHERE name = ? OR id = ? LIMIT 1`, query_name, query_name);
                if (rows.length === 0) return textResult(JSON.stringify({ error: 'crystal not found' }));
                const c = rows[0];
                return textResult(JSON.stringify({ crystal: { name: c.name, language: c.language, description: c.description, preconditions: JSON.parse(c.preconditions || '[]'), invariants: JSON.parse(c.invariants || '[]'), failure_modes: JSON.parse(c.failure_modes || '[]'), solution_pattern: c.solution_pattern } }, null, 2));
            }
            case 'stats': {
                try {
                    const [totalRow] = await dbAll(db, `SELECT COUNT(*) as total FROM skill_crystals`);
                    const byLang = await dbAll(db, `SELECT language, COUNT(*) as cnt FROM skill_crystals GROUP BY language ORDER BY cnt DESC`);
                    const [avgRow] = await dbAll(db, `SELECT AVG(LENGTH(preconditions)) as avg_pre, AVG(LENGTH(failure_modes)) as avg_fail FROM skill_crystals`);
                    const [newest] = await dbAll(db, `SELECT name FROM skill_crystals ORDER BY timestamp DESC LIMIT 1`);
                    // Parse JSON arrays to count items (approximate via comma counting)
                    const preRows = await dbAll(db, `SELECT preconditions, failure_modes FROM skill_crystals`);
                    let totalPre = 0, totalFail = 0;
                    for (const r of preRows) {
                        try { totalPre += JSON.parse(r.preconditions || '[]').length; } catch {}
                        try { totalFail += JSON.parse(r.failure_modes || '[]').length; } catch {}
                    }
                    const n = totalRow.total || preRows.length;
                    const byLanguage: Record<string, number> = {};
                    for (const r of byLang) { byLanguage[r.language] = r.cnt; }
                    return textResult(JSON.stringify({ total_crystals: totalRow.total, by_language: byLanguage, avg_preconditions: n > 0 ? Math.round((totalPre / n) * 10) / 10 : 0, avg_failure_modes: n > 0 ? Math.round((totalFail / n) * 10) / 10 : 0, newest: newest?.name ?? 'none', backend: 'duckdb' }, null, 2));
                } catch (e: any) { return textResult(JSON.stringify({ error: 'stats failed', detail: e.message })); }
            }
            default: return textResult(JSON.stringify({ error: `unknown action: ${action}` }));
        }
    }
}
