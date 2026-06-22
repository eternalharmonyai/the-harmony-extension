/**
 * Primitives shared header — imports and utilities used by all primitive files.
 * Re-exported from swarmPrimitives.ts barrel.
 */
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { concertSpeak, concertCheck, ConcertMessage } from '../concertHall';
import { safeHarmonyDir, appendJsonl, readJsonl, rewriteJsonl, readJson, writeJson } from '../swarmHarden';
import { idempotent, structuredLog } from '../storageUtils';

export function workspaceRoot(): string | undefined { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; }
export function textResult(text: string): vscode.LanguageModelToolResult {
    const c = text.length > 16000 ? text.slice(0, 16000) + '\n...[truncated]' : text;
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(c.trim() || '[empty]')]);
}
export function uid(): string { return crypto.randomUUID().slice(0, 8); }
export async function ensureDir(d: string): Promise<void> { await fs.mkdir(d, { recursive: true }); }
