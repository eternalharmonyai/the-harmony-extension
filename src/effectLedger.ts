import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { workspaceRoot } from './primitives/shared';

// Generalized reversible effect ledger.
//
// Every mutating action records an EffectRecord that carries either a true
// inverse (file content -> snapshot id) or a best-effort compensating action
// (terminal/spawn -> "kill <pid>"; secret -> prior-value hash, never plaintext).
// This is the Harmony equivalent of Cordis's "revertible effects", generalized
// beyond file edits. Append-only and additive: it never destroys data.

export type EffectKind = 'file' | 'terminal' | 'secret' | 'spawn' | 'other';

export interface EffectRecord {
    id: string;
    timestamp: string;
    kind: EffectKind;
    target: string;       // file path, command line, secret key, or process id
    action: string;       // 'write' | 'edit' | 'patch' | 'exec' | 'set' | 'spawn' | ...
    inverse?: string;     // file: snapshot id; secret: sha256 of prior value (never the value itself)
    compensating?: string;// terminal/spawn: compensating action (e.g. 'kill <pid>'); file: restore command
    status: 'recorded' | 'compensated' | 'failed';
    notes?: string;
}

interface EffectLedgerFile { version: 1; updatedAt: string; entries: EffectRecord[]; }

function effectLedgerPath(): string {
    const root = workspaceRoot();
    if (!root) throw new Error('no workspace folder is open');
    return path.join(root, '.harmony', 'operations', 'effects.json');
}

async function readEffectLedger(): Promise<EffectLedgerFile> {
    try {
        return JSON.parse(await fs.readFile(effectLedgerPath(), 'utf8')) as EffectLedgerFile;
    } catch {
        return { version: 1, updatedAt: new Date().toISOString(), entries: [] };
    }
}

async function writeEffectLedger(ledger: EffectLedgerFile): Promise<string> {
    const file = effectLedgerPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    ledger.updatedAt = new Date().toISOString();
    ledger.entries = ledger.entries.slice(-1000);
    await fs.writeFile(file, JSON.stringify(ledger, null, 2), 'utf8');
    return file;
}

export interface EffectInput {
    kind: EffectKind;
    target: string;
    action: string;
    inverse?: string;
    compensating?: string;
    notes?: string;
}

export async function recordEffect(effect: EffectInput): Promise<EffectRecord> {
    const ledger = await readEffectLedger();
    const entry: EffectRecord = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        kind: effect.kind,
        target: effect.target,
        action: effect.action,
        inverse: effect.inverse,
        compensating: effect.compensating,
        status: 'recorded',
        notes: effect.notes,
    };
    ledger.entries.push(entry);
    await writeEffectLedger(ledger);
    return entry;
}

export async function listEffects(limit = 50): Promise<EffectRecord[]> {
    const ledger = await readEffectLedger();
    const capped = Math.max(1, Math.min(200, Math.floor(limit) || 50));
    return ledger.entries.slice(-capped).reverse();
}

export function formatEffects(entries: EffectRecord[]): string {
    if (entries.length === 0) return '- No recorded effects yet.';
    return entries.map(entry => {
        const inverse = entry.inverse ? ` | inverse: ${entry.inverse}` : '';
        const comp = entry.compensating ? ` | compensate: ${entry.compensating}` : '';
        return `- ${entry.timestamp} | ${entry.status} | ${entry.kind} | ${entry.action} ${entry.target}${inverse}${comp}${entry.notes ? ` - ${entry.notes}` : ''}`;
    }).join('\n');
}
