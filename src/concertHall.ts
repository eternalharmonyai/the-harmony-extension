import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

// ── Concert Hall: background collaboration space ───────────────────────
// Rooms persist between turns. Workers leave messages. Conductor checks in.

export interface ConcertMessage {
    room: string;
    from: string;
    timestamp: number;
    body: string;
}

interface RoomManifest {
    last_watermark_line?: number;
    created_at: number;
}

function workspaceHash(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'default';
    return crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
}

function concertDir(): vscode.Uri | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return undefined;
    return vscode.Uri.joinPath(root, '.harmony', 'concert', workspaceHash());
}

async function ensureConcert(): Promise<vscode.Uri> {
    const dir = concertDir();
    if (!dir) throw new Error('no workspace open');
    await vscode.workspace.fs.createDirectory(dir);
    return dir;
}

function roomPath(dir: vscode.Uri, room: string): vscode.Uri {
    return vscode.Uri.joinPath(dir, `${room}.jsonl`);
}

function manifestPath(dir: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(dir, 'manifest.json');
}

async function readManifest(dir: vscode.Uri): Promise<RoomManifest> {
    try {
        const buf = await vscode.workspace.fs.readFile(manifestPath(dir));
        return JSON.parse(Buffer.from(buf).toString('utf8'));
    } catch {
        return { created_at: Date.now() };
    }
}

// ── Atomic manifest write using temp-then-rename to prevent TOCTOU races ──
async function writeManifestAtomic(dir: vscode.Uri, manifest: RoomManifest): Promise<void> {
    const mf = manifestPath(dir);
    const tmp = vscode.Uri.joinPath(dir, 'manifest.tmp');
    const buf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    await vscode.workspace.fs.writeFile(tmp, buf);
    // Atomic rename — prevents partial writes and TOCTOU between read/write.
    // On Windows, rename can fail with EBUSY if the target file is locked
    // (antivirus, backup, editor). We throw rather than falling back to a
    // non-atomic direct write — a concurrent readManifest during a direct
    // write could see a truncated/corrupt manifest, losing watermarks.
    await vscode.workspace.fs.rename(tmp, mf, { overwrite: true });
}

// ── Path validation ─────────────────────────────────────────────────────
const VALID_ROOM = /^[a-zA-Z0-9_-]+$/;

/** Post a message to a concert hall room. Thread-safe via append-only JSONL.
 *  The 'from' field is gated against harmony.concert.allowedFromNames;
 *  names not in the allowlist are remapped to 'ensemble'. */
export async function concertSpeak(room: string, from: string, body: string): Promise<void> {
    if (!VALID_ROOM.test(room)) throw new Error(`invalid room name: ${room}. Use only a-z, A-Z, 0-9, _, -.`);
    // Gate the 'from' field against the allowlist setting
    const allowed = vscode.workspace.getConfiguration('harmony').get<string[]>('concert.allowedFromNames') ?? [];
    const safeFrom = allowed.includes(from) ? from : 'ensemble';
    if (safeFrom !== from) {
        console.warn(`[Harmony Concert] Remapped 'from' name "${from}" → "ensemble" (not in harmony.concert.allowedFromNames)`);
    }
    const dir = await ensureConcert();
    const msg: ConcertMessage = { room, from: safeFrom, timestamp: Date.now(), body };
    const line = JSON.stringify(msg) + '\n';
    const rpFs = roomPath(dir, room).fsPath;
    await fs.mkdir(path.dirname(rpFs), { recursive: true });
    await fs.appendFile(rpFs, line, 'utf8');
}

function roomWatermarkKey(room: string): string { return `watermark_${room}`; }

/** Read all messages since last per-room watermark, or all messages if all=true.
 *  When all=true, watermarks are NOT advanced — safe for sidebar display. */
export async function concertCheck(rooms?: string[], all?: boolean): Promise<{ messages: ConcertMessage[]; summary?: string }> {
    const dir = concertDir();
    if (!dir) return { messages: [] };
    const manifest = await readManifest(dir) as Record<string, any>;

    const allMessages: ConcertMessage[] = [];
    const targetRooms = rooms ?? await listRooms(dir);

    for (const room of targetRooms) {
        const rp = roomPath(dir, room);
        const key = roomWatermarkKey(room);
        const watermark = all ? 0 : ((manifest[key] as number) ?? 0);  // all=true resets to 0
        try {
            const buf = await vscode.workspace.fs.readFile(rp);
            const lines = Buffer.from(buf).toString('utf8').split('\n').filter(Boolean);
            for (let i = watermark; i < lines.length; i++) {
                try { allMessages.push(JSON.parse(lines[i])); }
                catch { /* skip corrupt lines */ }
            }
            // Only advance watermark when NOT in 'all' mode (keep sidebar reads non-destructive)
            if (!all) manifest[key] = lines.length;
        } catch { /* room doesn't exist yet */ }
    }

    if (allMessages.length > 0 && !all) await writeManifestAtomic(dir, manifest as RoomManifest);
    return { messages: allMessages };
}

async function listRooms(dir: vscode.Uri): Promise<string[]> {
    const rooms: string[] = [];
    try {
        const entries = await vscode.workspace.fs.readDirectory(dir);
        for (const [name, type] of entries) {
            if (type === vscode.FileType.File && name.endsWith('.jsonl')) {
                rooms.push(name.replace('.jsonl', ''));
            }
        }
    } catch { /* dir may not exist */ }
    return rooms;
}

/** Format messages for display, with optional cloud-summarization warning. */
export function formatConcertCheck(messages: ConcertMessage[], summary?: string): string {
    if (messages.length === 0) return '🎻 Concert hall is quiet. No new messages since your last check-in.';

    const lines = [
        `🎻 **Concert Hall Check-in** — ${messages.length} new message(s)`,
        '',
        '⚠️ *To generate summaries, messages are sent to a cloud provider (e.g. Gemini Flash).*',
        '',
    ];

    if (summary) {
        lines.push('## Summary', '', summary, '');
    }

    // Group by room
    const byRoom = new Map<string, ConcertMessage[]>();
    for (const m of messages) byRoom.set(m.room, [...(byRoom.get(m.room) ?? []), m]);

    for (const [room, msgs] of byRoom) {
        lines.push(`### Room: ${room}`);
        for (const m of msgs) {
            const ts = new Date(m.timestamp).toISOString().slice(11, 19);
            lines.push(`- **[${ts}] ${m.from}:** ${m.body.slice(0, 200)}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}
