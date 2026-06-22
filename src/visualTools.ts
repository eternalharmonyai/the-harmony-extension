import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { ComposeImage } from './composeQueue';
import { recordUsage } from './costTracker';
import { confirmPremiumModel } from './providers';
import { describeImages } from './visionRouter';
import { withOperationLock } from './operationLocks';

const MAX_RESULT_CHARS = 60000;

function clip(s: string): string {
    if (s.length <= MAX_RESULT_CHARS) return s;
    return s.slice(0, MAX_RESULT_CHARS) + `\n...[truncated, ${s.length - MAX_RESULT_CHARS} more chars]`;
}

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(clip(text))
    ]);
}

function section(title: string, body: string | string[]): string {
    return `## ${title}\n\n${Array.isArray(body) ? (body.length ? body.map(item => `- ${item}`).join('\n') : '- (none)') : body}`;
}

function workspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    const active = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    return activeFolder?.uri.fsPath ?? (folders && folders.length > 0 ? folders[0].uri.fsPath : undefined);
}

function workspaceFoldersByPriority(): readonly vscode.WorkspaceFolder[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const active = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
    if (!activeFolder) return folders;
    return [activeFolder, ...folders.filter(folder => folder.uri.toString() !== activeFolder.uri.toString())];
}

function resolveWorkspacePath(p: string): string | undefined {
    const folders = workspaceFoldersByPriority();
    if (folders.length === 0) return undefined;

    for (const folder of folders) {
        const root = folder.uri.fsPath;
        const normalized = p.replace(/\\/g, '/');
        const folderPrefix = `${folder.name}/`;
        const relativePath = normalized.startsWith(folderPrefix) ? normalized.slice(folderPrefix.length) : p;
        const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, relativePath);
        const rel = path.relative(root, resolved);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) return resolved;
    }

    return undefined;
}

function npxCommand(): string {
    return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function npmCommand(): string {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function timestampSlug(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeName(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'harmony-asset';
}

function escapeXml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extensionForMime(mimeType: string): string {
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return '.jpg';
    if (mimeType.includes('webp')) return '.webp';
    if (mimeType.includes('gif')) return '.gif';
    return '.png';
}

function mimeTypeForPath(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    return 'image/png';
}

function sha256Buffer(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

interface ImageDimensions { width: number; height: number; format: 'png' | 'jpeg' | 'unknown'; }
export interface DecodedPng { width: number; height: number; rgba: Uint8Array; }
interface RgbaColor { r: number; g: number; b: number; a: number; }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(buffer: Buffer): boolean {
    return buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

function imageDimensions(buffer: Buffer): ImageDimensions {
    if (isPng(buffer)) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'png' };
    }
    if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < buffer.length) {
            if (buffer[offset] !== 0xff) break;
            const marker = buffer[offset + 1];
            const length = buffer.readUInt16BE(offset + 2);
            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5), format: 'jpeg' };
            }
            offset += 2 + length;
        }
    }
    return { width: 0, height: 0, format: 'unknown' };
}

function paethPredictor(left: number, above: number, upperLeft: number): number {
    const p = left + above - upperLeft;
    const pa = Math.abs(p - left);
    const pb = Math.abs(p - above);
    const pc = Math.abs(p - upperLeft);
    if (pa <= pb && pa <= pc) return left;
    return pb <= pc ? above : upperLeft;
}

export function decodePng(buffer: Buffer): DecodedPng | undefined {
    if (!isPng(buffer)) return undefined;
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idat: Buffer[] = [];
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd > buffer.length) return undefined;
        const data = buffer.subarray(dataStart, dataEnd);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
        offset = dataEnd + 4;
    }
    if (!width || !height || bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType) || idat.length === 0) return undefined;
    const bytesPerPixel = colorType === 6 ? 4 : 3;
    const stride = width * bytesPerPixel;
    let inflated: Buffer;
    try { inflated = zlib.inflateSync(Buffer.concat(idat)); } catch { return undefined; }
    const rgba = new Uint8Array(width * height * 4);
    let inputOffset = 0;
    let previous = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const filter = inflated[inputOffset++];
        const row = new Uint8Array(stride);
        for (let x = 0; x < stride; x++) {
            const raw = inflated[inputOffset++];
            const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
            const above = previous[x] ?? 0;
            const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
            const value = filter === 0 ? raw
                : filter === 1 ? raw + left
                    : filter === 2 ? raw + above
                        : filter === 3 ? raw + Math.floor((left + above) / 2)
                            : filter === 4 ? raw + paethPredictor(left, above, upperLeft)
                                : raw;
            row[x] = value & 0xff;
        }
        for (let x = 0; x < width; x++) {
            const source = x * bytesPerPixel;
            const target = (y * width + x) * 4;
            rgba[target] = row[source];
            rgba[target + 1] = row[source + 1];
            rgba[target + 2] = row[source + 2];
            rgba[target + 3] = bytesPerPixel === 4 ? row[source + 3] : 255;
        }
        previous = row;
    }
    return { width, height, rgba };
}

let crcTable: number[] | undefined;

function crc32(buffer: Buffer): number {
    if (!crcTable) {
        crcTable = [];
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            crcTable[n] = c >>> 0;
        }
    }
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
    const typeBuffer = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        const rowStart = y * (stride + 1);
        raw[rowStart] = 0;
        Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
    }
    return Buffer.concat([
        PNG_SIGNATURE,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

// ── Local algorithmic image analysis (zero dependencies, CPU-only) ──

interface DominantColor {
    hex: string;
    rgb: { r: number; g: number; b: number };
    percent: number;
    hsl?: { h: number; s: number; l: number };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function dominantColors(rgba: Uint8Array, width: number, height: number, maxColors = 5): DominantColor[] {
    const bucketBits = 5;
    const bucketCount = 1 << (bucketBits * 3);
    const buckets = new Uint32Array(bucketCount);
    const pixelCount = width * height;

    for (let i = 0; i < pixelCount; i++) {
        const offset = i * 4;
        const r = rgba[offset] >> (8 - bucketBits);
        const g = rgba[offset + 1] >> (8 - bucketBits);
        const b = rgba[offset + 2] >> (8 - bucketBits);
        const bucketIdx = (r << (bucketBits * 2)) | (g << bucketBits) | b;
        buckets[bucketIdx] = Math.min(buckets[bucketIdx] + 1, 0xFFFFFFFF);
    }

    const top: { idx: number; count: number }[] = [];
    for (let i = 0; i < bucketCount; i++) {
        if (buckets[i] === 0) continue;
        top.push({ idx: i, count: buckets[i] });
    }
    top.sort((a, b) => b.count - a.count);
    const result: DominantColor[] = [];
    for (let i = 0; i < Math.min(maxColors, top.length); i++) {
        const { idx, count } = top[i];
        const shift = 255 / ((1 << bucketBits) - 1);
        const r = Math.round(((idx >> (bucketBits * 2)) & ((1 << bucketBits) - 1)) * shift);
        const g = Math.round(((idx >> bucketBits) & ((1 << bucketBits) - 1)) * shift);
        const b = Math.round((idx & ((1 << bucketBits) - 1)) * shift);
        const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
        result.push({
            hex,
            rgb: { r, g, b },
            percent: Math.round((count / pixelCount) * 10000) / 100,
            hsl: rgbToHsl(r, g, b),
        });
    }
    return result;
}

function detectBlur(rgba: Uint8Array, width: number, height: number): { laplacianVariance: number; assessment: string; isBlurry: boolean } {
    const laplacian = new Float64Array(width * height);
    const kernel = [0, 1, 0, 1, -4, 1, 0, 1, 0];

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            let sum = 0;
            for (let ky = -1; ky <= 1; ky++) {
                for (let kx = -1; kx <= 1; kx++) {
                    const offset = ((y + ky) * width + (x + kx)) * 4;
                    const gray = rgba[offset] * 0.299 + rgba[offset + 1] * 0.587 + rgba[offset + 2] * 0.114;
                    sum += gray * kernel[(ky + 1) * 3 + (kx + 1)];
                }
            }
            laplacian[y * width + x] = sum;
        }
    }

    const pixelCount = (width - 2) * (height - 2);
    let mean = 0;
    for (let i = 0; i < pixelCount; i++) mean += laplacian[i];
    mean /= pixelCount;

    let variance = 0;
    for (let i = 0; i < pixelCount; i++) {
        const diff = laplacian[i] - mean;
        variance += diff * diff;
    }
    variance /= pixelCount;

    const isBlurry = variance < 50;
    const assessment = variance < 30 ? 'Very blurry — likely out of focus or low-quality'
        : variance < 50 ? 'Moderately blurry — may be acceptable for thumbnails'
        : variance < 100 ? 'Acceptable sharpness'
        : variance < 300 ? 'Sharp — good detail'
        : 'Very sharp — high detail / possibly over-sharpened';

    return {
        laplacianVariance: Math.round(variance * 100) / 100,
        assessment,
        isBlurry,
    };
}

function analyzeComposition(width: number, height: number): { aspectRatio: string; thirdsGrid: { h1: number; h2: number; v1: number; v2: number }; intersections: { x: number; y: number }[] } {
    const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
    const divisor = gcd(width, height);
    const ratioW = width / divisor;
    const ratioH = height / divisor;

    let aspectRatio: string;
    if (Math.abs(ratioW / ratioH - 16 / 9) < 0.05) aspectRatio = '16:9 (widescreen)';
    else if (Math.abs(ratioW / ratioH - 4 / 3) < 0.05) aspectRatio = '4:3 (standard)';
    else if (Math.abs(ratioW / ratioH - 1) < 0.05) aspectRatio = '1:1 (square)';
    else if (Math.abs(ratioW / ratioH - 3 / 2) < 0.05) aspectRatio = '3:2 (classic photo)';
    else aspectRatio = `${ratioW}:${ratioH}`;

    const h1 = Math.round(height / 3);
    const h2 = Math.round(height * 2 / 3);
    const v1 = Math.round(width / 3);
    const v2 = Math.round(width * 2 / 3);

    return {
        aspectRatio,
        thirdsGrid: { h1, h2, v1, v2 },
        intersections: [
            { x: v1, y: h1 }, { x: v2, y: h1 },
            { x: v1, y: h2 }, { x: v2, y: h2 },
        ],
    };
}

/** Run all local algorithmic analyses on a decoded PNG and return a formatted Markdown summary. */
export function summarizeLocalAnalysis(rgba: Uint8Array, width: number, height: number): string {
    const colors = dominantColors(rgba, width, height, 5);
    const blur = detectBlur(rgba, width, height);
    const composition = analyzeComposition(width, height);

    const colorLines = colors.map(c =>
        `- ${c.hex} — ${c.percent}% (HSL ${c.hsl!.h}°/${c.hsl!.s}%/${c.hsl!.l}%)`
    );

    return [
        `## Local Image Analysis (CPU-only, no API cost)`,
        ``,
        `### 📐 Composition`,
        `- Resolution: ${width}×${height} (${(width * height / 1_000_000).toFixed(1)} MP)`,
        `- Aspect ratio: ${composition.aspectRatio}`,
        `- Rule-of-thirds intersections at (${composition.intersections.map(p => `${p.x},${p.y}`).join(') (')})`,
        ``,
        `### 🔍 Sharpness`,
        `- Laplacian variance: ${blur.laplacianVariance}`,
        `- Assessment: ${blur.assessment}`,
        ``,
        `### 🎨 Dominant Colors`,
        ...colorLines,
        ``,
        `> 💡 This analysis ran locally on your CPU with zero API cost and maximum privacy.`,
    ].join('\n');
}

function parseColor(value: string | undefined, fallback: RgbaColor): RgbaColor {
    const raw = (value ?? '').trim();
    const hex = raw.startsWith('#') ? raw.slice(1) : raw;
    if (/^[0-9a-f]{3}$/i.test(hex)) {
        return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16), a: 255 };
    }
    if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) {
        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
            a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255,
        };
    }
    const rgba = raw.match(/^rgba?\(([^)]+)\)$/i);
    if (rgba) {
        const parts = rgba[1].split(',').map(part => Number(part.trim()));
        if (parts.length >= 3 && parts.every(part => Number.isFinite(part))) {
            return {
                r: Math.max(0, Math.min(255, Math.round(parts[0]))),
                g: Math.max(0, Math.min(255, Math.round(parts[1]))),
                b: Math.max(0, Math.min(255, Math.round(parts[2]))),
                a: Math.max(0, Math.min(255, Math.round((parts[3] ?? 1) <= 1 ? (parts[3] ?? 1) * 255 : parts[3]))),
            };
        }
    }
    return fallback;
}

function blendPixel(rgba: Uint8Array, width: number, x: number, y: number, color: RgbaColor): void {
    const offset = (y * width + x) * 4;
    const alpha = color.a / 255;
    const inverse = 1 - alpha;
    rgba[offset] = Math.round(color.r * alpha + rgba[offset] * inverse);
    rgba[offset + 1] = Math.round(color.g * alpha + rgba[offset + 1] * inverse);
    rgba[offset + 2] = Math.round(color.b * alpha + rgba[offset + 2] * inverse);
    rgba[offset + 3] = Math.min(255, Math.round(color.a + rgba[offset + 3] * inverse));
}

interface ImageComparison {
    beforePath: string;
    afterPath: string;
    beforeBytes: number;
    afterBytes: number;
    beforeSha256: string;
    afterSha256: string;
    beforeDimensions: ImageDimensions;
    afterDimensions: ImageDimensions;
    comparablePixels: boolean;
    pixelCount?: number;
    differentPixels?: number;
    percentDifferent?: number;
    averageChannelDelta?: number;
    maxChannelDelta?: number;
    sampleDiffs?: Array<{ x: number; y: number; delta: number }>;
    note: string;
}

function compareDecodedPngs(before: DecodedPng, after: DecodedPng, threshold: number, maxSamples: number): Pick<ImageComparison, 'pixelCount' | 'differentPixels' | 'percentDifferent' | 'averageChannelDelta' | 'maxChannelDelta' | 'sampleDiffs'> {
    const pixelCount = before.width * before.height;
    let differentPixels = 0;
    let totalDelta = 0;
    let maxChannelDelta = 0;
    const sampleDiffs: Array<{ x: number; y: number; delta: number }> = [];
    for (let pixel = 0; pixel < pixelCount; pixel++) {
        const offset = pixel * 4;
        const delta = Math.max(
            Math.abs(before.rgba[offset] - after.rgba[offset]),
            Math.abs(before.rgba[offset + 1] - after.rgba[offset + 1]),
            Math.abs(before.rgba[offset + 2] - after.rgba[offset + 2]),
            Math.abs(before.rgba[offset + 3] - after.rgba[offset + 3]),
        );
        if (delta > threshold) {
            differentPixels++;
            totalDelta += delta;
            maxChannelDelta = Math.max(maxChannelDelta, delta);
            if (sampleDiffs.length < maxSamples) sampleDiffs.push({ x: pixel % before.width, y: Math.floor(pixel / before.width), delta });
        }
    }
    return {
        pixelCount,
        differentPixels,
        percentDifferent: pixelCount ? Number(((differentPixels / pixelCount) * 100).toFixed(4)) : 0,
        averageChannelDelta: differentPixels ? Number((totalDelta / differentPixels).toFixed(2)) : 0,
        maxChannelDelta,
        sampleDiffs,
    };
}

async function compareImageFiles(beforeInput: string, afterInput: string, threshold: number, maxSamples: number): Promise<ImageComparison | string> {
    const beforeAbs = resolveWorkspacePath(beforeInput);
    const afterAbs = resolveWorkspacePath(afterInput);
    if (!beforeAbs || !afterAbs) return 'error: before_path and after_path must resolve inside the open workspace';
    const beforeBuffer = await fs.readFile(beforeAbs).catch(() => undefined);
    const afterBuffer = await fs.readFile(afterAbs).catch(() => undefined);
    if (!beforeBuffer || !afterBuffer) return 'error: one or both image files could not be read';
    const beforeDimensions = imageDimensions(beforeBuffer);
    const afterDimensions = imageDimensions(afterBuffer);
    const comparison: ImageComparison = {
        beforePath: beforeInput,
        afterPath: afterInput,
        beforeBytes: beforeBuffer.length,
        afterBytes: afterBuffer.length,
        beforeSha256: sha256Buffer(beforeBuffer).slice(0, 16),
        afterSha256: sha256Buffer(afterBuffer).slice(0, 16),
        beforeDimensions,
        afterDimensions,
        comparablePixels: false,
        note: 'Pixel comparison requires two non-interlaced 8-bit RGB/RGBA PNG files with matching dimensions.'
    };
    const beforePng = decodePng(beforeBuffer);
    const afterPng = decodePng(afterBuffer);
    if (beforePng && afterPng && beforePng.width === afterPng.width && beforePng.height === afterPng.height) {
        Object.assign(comparison, compareDecodedPngs(beforePng, afterPng, threshold, maxSamples));
        comparison.comparablePixels = true;
        comparison.note = 'Pixel comparison completed with thresholded max-channel delta.';
    } else if (beforeDimensions.width !== afterDimensions.width || beforeDimensions.height !== afterDimensions.height) {
        comparison.note = 'Image dimensions differ; treat this as a layout/regression signal before pixel comparison.';
    }
    return comparison;
}

function normalizeWorkspaceRel(rel: string): string {
    return rel.replace(/\\/g, '/');
}

async function workspaceOutputPath(folder: string, prefix: string, ext: string, requested?: string): Promise<{ rel: string; abs: string }> {
    const rel = normalizeWorkspaceRel((requested && requested.trim()) || path.posix.join('.harmony', folder, `${safeName(prefix)}-${timestampSlug()}${ext}`));
    const abs = resolveWorkspacePath(rel);
    if (!abs) throw new Error(`output path is outside workspace: ${rel}`);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    return { rel, abs };
}

function normalizeUrl(input: { url?: string; port?: number }): string | undefined {
    const raw = input.url && input.url.trim()
        ? input.url.trim()
        : (input.port ? `http://127.0.0.1:${Math.floor(Number(input.port))}` : undefined);
    if (!raw) return undefined;
    let parsed: URL;
    try { parsed = new URL(raw); } catch { return undefined; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.toString();
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

interface ProcessRun {
    ok: boolean;
    stdout: string;
    stderr: string;
    code?: number | string | null;
    error?: string;
}

let npxRunQueue: Promise<unknown> = Promise.resolve();

async function pathExists(p: string): Promise<boolean> {
    return fs.access(p).then(() => true).catch(() => false);
}

async function execFile(command: string, args: string[], cwd: string | undefined, timeoutMs: number, token: vscode.CancellationToken): Promise<ProcessRun> {
    return await new Promise<ProcessRun>((resolve) => {
        let sub: vscode.Disposable | undefined;
        let settled = false;
        const settle = (run: ProcessRun) => {
            if (settled) return;
            settled = true;
            sub?.dispose();
            resolve(run);
        };
        let proc: cp.ChildProcess;
        try {
            proc = cp.execFile(command, args, {
                cwd,
                timeout: timeoutMs,
                windowsHide: true,
                maxBuffer: 30 * 1024 * 1024,
                shell: true,
            }, (err, stdout, stderr) => {
                if (err) {
                    settle({ ok: false, stdout: stdout ?? '', stderr: stderr ?? '', code: (err as cp.ExecFileException).code, error: err.message });
                    return;
                }
                settle({ ok: true, stdout: stdout ?? '', stderr: stderr ?? '', code: 0 });
            });
        } catch (e: any) {
            settle({ ok: false, stdout: '', stderr: '', code: (e as NodeJS.ErrnoException).code, error: e?.message ?? String(e) });
            return;
        }
        sub = token.onCancellationRequested(() => proc.kill());
        proc.on('exit', () => sub?.dispose());
        proc.on('error', (e) => {
            settle({ ok: false, stdout: '', stderr: '', code: (e as NodeJS.ErrnoException).code, error: e.message });
        });
    });
}

async function runNpxNodeScript(packageName: string, script: string, input: unknown, timeoutMs: number, token: vscode.CancellationToken): Promise<ProcessRun> {
    const previous = npxRunQueue.catch(() => undefined);
    const queued = previous.then(() => runNpxNodeScriptNow(packageName, script, input, timeoutMs, token));
    npxRunQueue = queued.catch(() => undefined);
    return queued;
}

async function runNpxNodeScriptNow(packageName: string, script: string, input: unknown, timeoutMs: number, token: vscode.CancellationToken): Promise<ProcessRun> {
    const cache = await ensureNodePackageCache(packageName, token);
    if (!cache.ok) return { ok: false, stdout: '', stderr: '', error: cache.message };
    const tmp = await fs.mkdtemp(path.join(cache.dir, 'run-'));
    const scriptPath = path.join(tmp, 'tool.js');
    try {
        await fs.writeFile(scriptPath, script, 'utf8');
        const encoded = Buffer.from(JSON.stringify(input), 'utf8').toString('base64');
        const nodeExe = process.platform === 'win32' ? 'node' : process.execPath;
        let run = await execFile(nodeExe, [scriptPath, encoded], workspaceRoot() ?? tmp, timeoutMs, token);
        if (!run.ok && (run.code === 'ENOENT' || (run.error && /EINVAL/i.test(run.error)))) {
            run = await execFile('node', [scriptPath, encoded], workspaceRoot() ?? tmp, timeoutMs, token);
        }
        if (!run.ok && run.code === 'ENOENT') {
            return {
                ...run,
                error: `${run.error ?? 'node execution failed'}\nHarmony browser tools require Node.js to run the Playwright helper.`
            };
        }
        return run;
    } finally {
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
}

function packageCacheSlug(packageName: string): string {
    return packageName.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function packageNameWithoutVersion(packageName: string): string {
    if (packageName.startsWith('@')) {
        const secondAt = packageName.indexOf('@', 1);
        return secondAt >= 0 ? packageName.slice(0, secondAt) : packageName;
    }
    const at = packageName.indexOf('@');
    return at >= 0 ? packageName.slice(0, at) : packageName;
}

async function ensureNodePackageCache(packageName: string, token: vscode.CancellationToken): Promise<{ ok: true; dir: string } | { ok: false; message: string }> {
    const root = workspaceRoot();
    if (!root) return { ok: false, message: 'no workspace folder is open' };
    const cacheDir = path.join(root, '.harmony', 'tool-cache', packageCacheSlug(packageName));
    const moduleName = packageNameWithoutVersion(packageName);
    const modulePackageJson = path.join(cacheDir, 'node_modules', moduleName, 'package.json');
    if (await pathExists(modulePackageJson)) return { ok: true, dir: cacheDir };

    const allowInstall = vscode.workspace.getConfiguration('harmony').get<boolean>('visual.allowNpxInstall') ?? true;
    if (!allowInstall) {
        return { ok: false, message: `Playwright package cache is missing at ${cacheDir}, and harmony.visual.allowNpxInstall is false.` };
    }

    await fs.mkdir(cacheDir, { recursive: true });
    const packageJson = path.join(cacheDir, 'package.json');
    if (!await pathExists(packageJson)) {
        await fs.writeFile(packageJson, JSON.stringify({ private: true, dependencies: {} }, null, 2), 'utf8');
    }
    const install = await execFile(npmCommand(), ['install', '--no-audit', '--no-fund', '--prefer-offline', '--save-exact', packageName], cacheDir, 300000, token);
    if (!install.ok) {
        return { ok: false, message: [install.error, install.stderr, install.stdout].filter(Boolean).join('\n') || `npm install ${packageName} failed` };
    }
    if (!await pathExists(modulePackageJson)) {
        return { ok: false, message: `npm install completed but ${modulePackageJson} was not found.` };
    }
    return { ok: true, dir: cacheDir };
}

function parseJsonOutput<T>(run: ProcessRun): { ok: true; value: T } | { ok: false; message: string } {
    const raw = (run.stdout || '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end < start) {
        return { ok: false, message: [run.error, run.stderr, run.stdout].filter(Boolean).join('\n') || 'tool produced no JSON output' };
    }
    try {
        return { ok: true, value: JSON.parse(raw.slice(start, end + 1)) as T };
    } catch (e: any) {
        return { ok: false, message: `could not parse tool JSON: ${e?.message ?? String(e)}\n${raw.slice(0, 2000)}` };
    }
}

async function analyzeImageFile(abs: string, rel: string, note: string, secrets: vscode.SecretStorage, token: vscode.CancellationToken): Promise<string> {
    const buf = await fs.readFile(abs);
    const image: ComposeImage = {
        mimeType: mimeTypeForPath(rel),
        base64: buf.toString('base64'),
        name: path.basename(rel)
    };
    const vision = await describeImages([image], note, secrets, token);
    return [
        `Image analysis via ${vision.routedTo}${vision.partial ? ' (partial)' : ''}:`,
        vision.description
    ].join('\n');
}

const PLAYWRIGHT_SCRIPT = String.raw`
const fs = require('fs');

function send(value) {
  process.stdout.write(JSON.stringify(value));
}

(async () => {
  let chromium;
  try {
    chromium = require('playwright').chromium;
  } catch (error) {
    send({ ok: false, error: 'Playwright could not be loaded: ' + (error && error.message ? error.message : String(error)) });
    return;
  }

  const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
  const browser = await chromium.launch({ headless: true });
  const outputs = [];
  const consoleMessages = [];
  try {
    const page = await browser.newPage({
      viewport: { width: input.viewportWidth || 1280, height: input.viewportHeight || 800 },
      deviceScaleFactor: input.deviceScaleFactor || 1
    });
    page.on('console', msg => consoleMessages.push('console.' + msg.type() + ': ' + msg.text()));
    page.on('pageerror', err => consoleMessages.push('pageerror: ' + err.message));

    await page.goto(input.url, { waitUntil: input.waitUntil || 'domcontentloaded', timeout: input.timeoutMs || 30000 });
    if (input.waitMs) await page.waitForTimeout(input.waitMs);

    for (const step of input.actions || []) {
      const timeout = step.timeout_ms || input.actionTimeoutMs || 10000;
      try {
        if (step.action === 'click') {
          await page.locator(step.selector).first().click({ timeout });
          outputs.push({ action: step.action, selector: step.selector, ok: true });
        } else if (step.action === 'hover') {
          await page.locator(step.selector).first().hover({ timeout });
          outputs.push({ action: step.action, selector: step.selector, ok: true });
        } else if (step.action === 'fill') {
          await page.locator(step.selector).first().fill(step.text || '', { timeout });
          outputs.push({ action: step.action, selector: step.selector, ok: true });
        } else if (step.action === 'press') {
          await page.locator(step.selector || 'body').first().press(step.key || 'Enter', { timeout });
          outputs.push({ action: step.action, selector: step.selector || 'body', key: step.key || 'Enter', ok: true });
        } else if (step.action === 'scroll') {
          if (step.selector) {
            await page.locator(step.selector).first().evaluate((el, y) => el.scrollBy(0, y), Number(step.y || 800));
          } else {
            await page.mouse.wheel(Number(step.x || 0), Number(step.y || 800));
          }
          outputs.push({ action: step.action, selector: step.selector, ok: true });
        } else if (step.action === 'wait') {
          await page.waitForTimeout(Number(step.ms || step.wait_ms || 1000));
          outputs.push({ action: step.action, ok: true });
        } else if (step.action === 'get_text') {
          const text = await page.locator(step.selector || 'body').first().innerText({ timeout });
          outputs.push({ action: step.action, selector: step.selector || 'body', ok: true, value: text });
        } else if (step.action === 'get_html') {
          const html = await page.locator(step.selector || 'body').first().innerHTML({ timeout });
          outputs.push({ action: step.action, selector: step.selector || 'body', ok: true, value: html });
        } else if (step.action === 'get_attribute') {
          const value = await page.locator(step.selector).first().getAttribute(step.attribute || 'class', { timeout });
          outputs.push({ action: step.action, selector: step.selector, attribute: step.attribute || 'class', ok: true, value });
        } else if (step.action === 'get_computed_style') {
          const value = await page.locator(step.selector).first().evaluate((el, property) => {
            const style = getComputedStyle(el);
            if (property) return style.getPropertyValue(property);
            return {
              display: style.display,
              position: style.position,
              opacity: style.opacity,
              transform: style.transform,
              transition: style.transition,
              animation: style.animation,
              color: style.color,
              backgroundColor: style.backgroundColor,
              width: style.width,
              height: style.height
            };
          }, step.property || null);
          outputs.push({ action: step.action, selector: step.selector, property: step.property || null, ok: true, value });
        } else if (step.action === 'count') {
          const value = await page.locator(step.selector).count();
          outputs.push({ action: step.action, selector: step.selector, ok: true, value });
        } else {
          outputs.push({ action: step.action, ok: false, error: 'unknown action' });
        }
        if (step.wait_ms_after) await page.waitForTimeout(Number(step.wait_ms_after));
      } catch (error) {
        outputs.push({ action: step.action, selector: step.selector, ok: false, error: error && error.message ? error.message : String(error) });
      }
    }

    if (input.screenshotPath) {
      await page.screenshot({ path: input.screenshotPath, fullPage: !!input.fullPage });
    }

    send({
      ok: true,
      title: await page.title(),
      url: page.url(),
      outputs,
      console: consoleMessages.slice(-50)
    });
  } catch (error) {
    send({ ok: false, error: error && error.message ? error.message : String(error), outputs, console: consoleMessages.slice(-50) });
  } finally {
    await browser.close();
  }
})().catch(error => send({ ok: false, error: error && error.message ? error.message : String(error) }));
`;

interface BrowserStep {
    action: 'click' | 'hover' | 'fill' | 'press' | 'scroll' | 'wait' | 'get_text' | 'get_html' | 'get_attribute' | 'get_computed_style' | 'count';
    selector?: string;
    text?: string;
    key?: string;
    x?: number;
    y?: number;
    ms?: number;
    wait_ms?: number;
    wait_ms_after?: number;
    timeout_ms?: number;
    attribute?: string;
    property?: string;
}

interface PlaywrightResult {
    ok: boolean;
    title?: string;
    url?: string;
    outputs?: unknown[];
    console?: string[];
    error?: string;
    repair?: string;
}

async function runPlaywright(input: unknown, timeoutMs: number, token: vscode.CancellationToken): Promise<PlaywrightResult> {
    const packageName = 'playwright@1.49.1';
    const run = await runNpxNodeScript(packageName, PLAYWRIGHT_SCRIPT, input, timeoutMs, token);
    const parsed = parseJsonOutput<PlaywrightResult>(run);
    if (!parsed.ok) {
        return { ok: false, error: parsed.message };
    }
    if (parsed.value.ok || token.isCancellationRequested) return parsed.value;

    const firstError = parsed.value.error ?? '';
    if (!shouldRepairPlaywright(firstError)) return parsed.value;

    const repair = await installPlaywrightChromium(packageName, token);
    if (!repair.ok) {
        return { ok: false, error: `${firstError}\n\nPlaywright repair failed:\n${repair.message}` };
    }

    const retry = await runNpxNodeScript(packageName, PLAYWRIGHT_SCRIPT, input, timeoutMs, token);
    const retryParsed = parseJsonOutput<PlaywrightResult>(retry);
    if (!retryParsed.ok) {
        return { ok: false, error: `${firstError}\n\nPlaywright repair attempted: ${repair.message}\nRetry failed:\n${retryParsed.message}` };
    }
    return { ...retryParsed.value, repair: repair.message };
}

function shouldRepairPlaywright(message: string): boolean {
    return /executable doesn't exist|please run.*playwright install|browser executable|spawn EINVAL|failed to launch/i.test(message);
}

function browserFallbackPlan(intent: string, url?: string, error?: string): Record<string, unknown> {
    return {
        status: 'available',
        reason: error ? error.slice(0, 800) : 'Harmony Playwright browser path is unavailable.',
        intent,
        url: url ?? null,
        integrated_browser_steps: [
            url ? `Open ${url} with open_browser_page.` : 'Open the target URL with open_browser_page.',
            'Use the returned accessibility snapshot or read_page to inspect visible page state.',
            'Use screenshot_page to capture the current viewport.',
            'Continue the task from the Integrated Browser snapshot while Playwright is repaired separately.'
        ],
        harmony_repair_steps: [
            'Run harmony_browser_health with repair:false to inspect the current Playwright cache state.',
            'Run harmony_browser_health with repair:true after confirmation if the package or Chromium cache is missing.',
            'Reload VS Code or Cursor after installing a VSIX that changes browser tooling.'
        ]
    };
}

function formatBrowserFallback(intent: string, url?: string, error?: string): string {
    const plan = browserFallbackPlan(intent, url, error);
    const browserSteps = plan.integrated_browser_steps as string[];
    const repairSteps = plan.harmony_repair_steps as string[];
    return [
        'Integrated Browser fallback:',
        ...browserSteps.map(step => `- ${step}`),
        '',
        'Harmony repair path:',
        ...repairSteps.map(step => `- ${step}`)
    ].join('\n');
}

async function installPlaywrightChromium(packageName: string, token: vscode.CancellationToken): Promise<{ ok: boolean; message: string }> {
    const allowInstall = vscode.workspace.getConfiguration('harmony').get<boolean>('visual.allowNpxInstall') ?? true;
    if (!allowInstall) {
        return { ok: false, message: 'harmony.visual.allowNpxInstall is false, so Harmony will not download Playwright Chromium.' };
    }
    const cache = await ensureNodePackageCache(packageName, token);
    if (!cache.ok) return { ok: false, message: cache.message };
    const nodeExe2 = process.platform === 'win32' ? 'node' : process.execPath;
    let run = await execFile(nodeExe2, [path.join(cache.dir, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'], cache.dir, 300000, token);
    if (!run.ok && run.error && /EINVAL/i.test(run.error)) {
        run = await execFile('node', [path.join(cache.dir, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'], cache.dir, 300000, token);
    }
    if (!run.ok) {
        return { ok: false, message: [run.error, run.stderr, run.stdout].filter(Boolean).join('\n') || 'playwright install chromium failed with no output' };
    }
    return { ok: true, message: 'Installed or verified Playwright Chromium cache, then retried the browser action.' };
}

interface BrowserHealthInput {
    repair?: boolean;
}

class BrowserHealthTool implements vscode.LanguageModelTool<BrowserHealthInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<BrowserHealthInput>, token: vscode.CancellationToken) {
        const planOnly = vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false;
        if (planOnly && options.input.repair) return textResult('error: plan-only mode is enabled; browser health can inspect but cannot repair/install packages.');
        const packageName = 'playwright@1.49.1';
        const root = workspaceRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const cacheDir = path.join(root, '.harmony', 'tool-cache', packageCacheSlug(packageName));
        const modulePackageJson = path.join(cacheDir, 'node_modules', 'playwright', 'package.json');
        const packageCachedBefore = await pathExists(modulePackageJson);
        let cacheResult: { ok: true; dir: string } | { ok: false; message: string } = packageCachedBefore
            ? { ok: true, dir: cacheDir }
            : { ok: false, message: `Playwright package cache is missing at ${cacheDir}.` };

        if (!packageCachedBefore && options.input.repair) {
            cacheResult = await ensureNodePackageCache(packageName, token);
        }

        let launchOk = false;
        let launchError = '';
        if (cacheResult.ok) {
            const probeScript = `const { chromium } = require('playwright'); chromium.launch({ headless: true }).then(async b => { await b.close(); console.log(JSON.stringify({ ok: true })); }).catch(e => { console.log(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) })); process.exit(0); });`;
            const run = await runNpxNodeScript(packageName, probeScript, {}, 60000, token);
            const parsed = parseJsonOutput<{ ok: boolean; error?: string }>(run);
            if (parsed.ok) {
                launchOk = !!parsed.value.ok;
                launchError = parsed.value.error ?? '';
            } else {
                launchError = parsed.message;
            }
            if (!launchOk && options.input.repair && shouldRepairPlaywright(launchError)) {
                const repair = await installPlaywrightChromium(packageName, token);
                if (repair.ok) {
                    const retry = await runNpxNodeScript(packageName, probeScript, {}, 60000, token);
                    const retryParsed = parseJsonOutput<{ ok: boolean; error?: string }>(retry);
                    launchOk = retryParsed.ok && !!retryParsed.value.ok;
                    launchError = retryParsed.ok ? (retryParsed.value.error ?? '') : retryParsed.message;
                } else {
                    launchError = `${launchError}\nRepair failed: ${repair.message}`;
                }
            }
        }

        return textResult(JSON.stringify({
            package: packageName,
            workspace: root,
            cache_dir: cacheDir,
            package_cached_before: packageCachedBefore,
            package_cached_now: cacheResult.ok,
            package_error: cacheResult.ok ? null : cacheResult.message,
            chromium_launch_ok: launchOk,
            chromium_error: launchOk ? null : launchError || null,
            fallback: launchOk ? null : browserFallbackPlan('browser health probe', undefined, launchError || (cacheResult.ok ? undefined : cacheResult.message)),
            repair_requested: !!options.input.repair,
            allow_npm_install: vscode.workspace.getConfiguration('harmony').get<boolean>('visual.allowNpxInstall') ?? true,
        }, null, 2));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<BrowserHealthInput>) {
        const base = { invocationMessage: options.input.repair ? 'Checking and repairing browser tooling' : 'Checking browser tooling' };
        if (!options.input.repair) return base;
        return {
            ...base,
            confirmationMessages: {
                title: 'Repair browser tooling?',
                message: new vscode.MarkdownString('Harmony may install Playwright/Chromium into the local cache so screenshot and browser-action tools can run.')
            }
        };
    }
}

interface ScreenshotInput {
    url?: string;
    port?: number;
    output_path?: string;
    viewport_width?: number;
    viewport_height?: number;
    device_scale_factor?: number;
    full_page?: boolean;
    wait_ms?: number;
    timeout_sec?: number;
    analyze?: boolean;
}

export class ScreenshotTool implements vscode.LanguageModelTool<ScreenshotInput> {
    constructor(private readonly secrets: vscode.SecretStorage) {}

    async invoke(options: vscode.LanguageModelToolInvocationOptions<ScreenshotInput>, token: vscode.CancellationToken) {
        const url = normalizeUrl(options.input);
        if (!url) return textResult('error: provide a valid http(s) url or port');
        try {
            const width = clampNumber(options.input.viewport_width, 1280, 320, 3840);
            const height = clampNumber(options.input.viewport_height, 800, 320, 2160);
            const waitMs = clampNumber(options.input.wait_ms, 750, 0, 30000);
            const timeoutMs = clampNumber(options.input.timeout_sec, 60, 5, 300) * 1000;
            const out = await workspaceOutputPath('screenshots', 'screenshot', '.png', options.input.output_path);
            const result = await runPlaywright({
                url,
                viewportWidth: width,
                viewportHeight: height,
                deviceScaleFactor: clampNumber(options.input.device_scale_factor, 1, 1, 4),
                fullPage: options.input.full_page ?? true,
                waitMs,
                timeoutMs,
                screenshotPath: out.abs,
                actions: []
            }, timeoutMs + 15000, token);
            if (!result.ok) return textResult(`error: screenshot failed\n${result.error ?? 'unknown error'}\n\n${formatBrowserFallback('screenshot capture', url, result.error)}`);

            const lines = [
                `Screenshot saved: ${out.rel}`,
                `URL: ${result.url ?? url}`,
                `Title: ${result.title ?? '(untitled)'}`,
                `Viewport: ${width}x${height}`
            ];
            if (result.repair) lines.push('', result.repair);
            if (options.input.analyze ?? true) {
                const note = `This is a live website screenshot captured from ${url}. Describe layout, visible text, spacing, visual hierarchy, animation state if visible, and any obvious UI defects.`;
                lines.push('', await analyzeImageFile(out.abs, out.rel, note, this.secrets, token));
            }
            return textResult(lines.join('\n'));
        } catch (e: any) {
            const message = e?.message ?? String(e);
            return textResult(`error: ${message}\n\n${formatBrowserFallback('screenshot capture', url, message)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ScreenshotInput>) {
        return { invocationMessage: `Capturing screenshot of ${options.input.url ?? `port ${options.input.port ?? '?'}`}` };
    }
}

interface BrowserActionInput extends ScreenshotInput {
    actions?: BrowserStep[];
    capture_screenshot?: boolean;
    analyze_screenshot?: boolean;
    action_timeout_ms?: number;
}

export class BrowserActionTool implements vscode.LanguageModelTool<BrowserActionInput> {
    constructor(private readonly secrets: vscode.SecretStorage) {}

    async invoke(options: vscode.LanguageModelToolInvocationOptions<BrowserActionInput>, token: vscode.CancellationToken) {
        const url = normalizeUrl(options.input);
        if (!url) return textResult('error: provide a valid http(s) url or port');
        try {
            const width = clampNumber(options.input.viewport_width, 1280, 320, 3840);
            const height = clampNumber(options.input.viewport_height, 800, 320, 2160);
            const timeoutMs = clampNumber(options.input.timeout_sec, 60, 5, 300) * 1000;
            const capture = options.input.capture_screenshot ?? false;
            const out = capture
                ? await workspaceOutputPath('screenshots', 'browser-action', '.png', options.input.output_path)
                : undefined;
            const result = await runPlaywright({
                url,
                viewportWidth: width,
                viewportHeight: height,
                deviceScaleFactor: clampNumber(options.input.device_scale_factor, 1, 1, 4),
                fullPage: options.input.full_page ?? true,
                waitMs: clampNumber(options.input.wait_ms, 500, 0, 30000),
                timeoutMs,
                actionTimeoutMs: clampNumber(options.input.action_timeout_ms, 10000, 1000, 60000),
                screenshotPath: out?.abs,
                actions: options.input.actions ?? []
            }, timeoutMs + 15000, token);
            if (!result.ok) return textResult(`error: browser action failed\n${result.error ?? 'unknown error'}\n\n${formatBrowserFallback('browser action', url, result.error)}`);

            const lines: string[] = [
                `Browser action complete.`,
                `URL: ${result.url ?? url}`,
                `Title: ${result.title ?? '(untitled)'}`
            ];
            if (result.repair) lines.push('', result.repair);
            if (Array.isArray(result.outputs) && result.outputs.length > 0) {
                lines.push('', 'Action results:', JSON.stringify(result.outputs, null, 2));
            }
            if (Array.isArray(result.console) && result.console.length > 0) {
                lines.push('', 'Console messages:', ...result.console);
            }
            if (out) {
                lines.push('', `Screenshot saved: ${out.rel}`);
                if (options.input.analyze_screenshot ?? false) {
                    const note = `This screenshot was captured after browser actions on ${url}. Explain what changed, whether interactions appear successful, and any visual defects.`;
                    lines.push('', await analyzeImageFile(out.abs, out.rel, note, this.secrets, token));
                }
            }
            return textResult(lines.join('\n'));
        } catch (e: any) {
            const message = e?.message ?? String(e);
            return textResult(`error: ${message}\n\n${formatBrowserFallback('browser action', url, message)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<BrowserActionInput>) {
        const autoApprove = vscode.workspace.getConfiguration('harmony').get<boolean>('autoApproveTools') ?? false;
        const count = options.input.actions?.length ?? 0;
        const base = { invocationMessage: `Running ${count} browser action${count === 1 ? '' : 's'} on ${options.input.url ?? `port ${options.input.port ?? '?'}`}` };
        if (autoApprove) return base;
        return {
            ...base,
            confirmationMessages: {
                title: 'Run browser actions?',
                message: new vscode.MarkdownString(`Harmony wants to open a headless browser and run **${count} action${count === 1 ? '' : 's'}** on ${options.input.url ?? `port ${options.input.port ?? '?'}`}.`)
            }
        };
    }
}

const WEBSITE_INSPECT_SCRIPT = String.raw`
function send(value) {
    process.stdout.write(JSON.stringify(value));
}

function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

(async () => {
    let chromium;
    try {
        chromium = require('playwright').chromium;
    } catch (error) {
        send({ ok: false, error: 'Playwright could not be loaded: ' + (error && error.message ? error.message : String(error)) });
        return;
    }

    const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
    const browser = await chromium.launch({ headless: true });
    const consoleMessages = [];
    try {
        const page = await browser.newPage({
            viewport: { width: input.viewportWidth || 1280, height: input.viewportHeight || 800 },
            deviceScaleFactor: input.deviceScaleFactor || 1
        });
        page.on('console', message => consoleMessages.push('console.' + message.type() + ': ' + message.text()));
        page.on('pageerror', error => consoleMessages.push('pageerror: ' + error.message));
        await page.goto(input.url, { waitUntil: input.waitUntil || 'domcontentloaded', timeout: input.timeoutMs || 30000 });
        if (input.waitMs) await page.waitForTimeout(input.waitMs);

        const inspection = await page.evaluate((maxItems) => {
            const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
            const visibleText = (element) => clean(element.innerText || element.textContent || '');
            const attr = (element, name) => element.getAttribute(name) || '';
            const roleName = (element) => attr(element, 'aria-label') || attr(element, 'title') || visibleText(element);
            const labelFor = (inputElement) => {
                const id = attr(inputElement, 'id');
                const aria = attr(inputElement, 'aria-label') || attr(inputElement, 'aria-labelledby');
                if (aria) return aria;
                if (id) {
                    const label = document.querySelector('label[for="' + CSS.escape(id) + '"]');
                    if (label) return visibleText(label);
                }
                const wrapped = inputElement.closest('label');
                return wrapped ? visibleText(wrapped) : '';
            };
            const allIds = Array.from(document.querySelectorAll('[id]')).map((element) => attr(element, 'id')).filter(Boolean);
            const duplicateIds = Array.from(new Set(allIds.filter((id, index) => allIds.indexOf(id) !== index)));
            const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0, maxItems).map((heading) => ({
                level: heading.tagName.toLowerCase(),
                text: visibleText(heading).slice(0, 220)
            }));
            const links = Array.from(document.querySelectorAll('a[href]')).slice(0, maxItems).map((link) => ({
                text: visibleText(link).slice(0, 180),
                href: link.href
            }));
            const buttons = Array.from(document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')).slice(0, maxItems).map((button) => {
                const rect = button.getBoundingClientRect();
                return {
                    name: roleName(button).slice(0, 180),
                    tag: button.tagName.toLowerCase(),
                    disabled: !!button.disabled || attr(button, 'aria-disabled') === 'true',
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                };
            });
            const fields = Array.from(document.querySelectorAll('input,select,textarea')).slice(0, maxItems).map((field) => ({
                tag: field.tagName.toLowerCase(),
                type: attr(field, 'type') || field.tagName.toLowerCase(),
                name: attr(field, 'name'),
                label: labelFor(field).slice(0, 180),
                required: !!field.required || attr(field, 'aria-required') === 'true'
            }));
            const images = Array.from(document.images).slice(0, maxItems).map((image) => ({
                alt: attr(image, 'alt'),
                src: image.currentSrc || image.src,
                width: image.naturalWidth || image.width,
                height: image.naturalHeight || image.height
            }));
            const bodyStyle = getComputedStyle(document.body);
            const rootStyle = getComputedStyle(document.documentElement);
            const focusables = Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'));
            const smallTargets = focusables.map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0 && (rect.width < 40 || rect.height < 40)).length;
            const namedButtons = buttons.filter((button) => clean(button.name).length > 0).length;
            const labelledFields = fields.filter((field) => clean(field.label).length > 0 || clean(field.name).length > 0).length;
            const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
            return {
                title: document.title,
                url: location.href,
                lang: document.documentElement.lang || '',
                meta: {
                    description: metaDescription,
                    viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '',
                    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || ''
                },
                counts: {
                    headings: headings.length,
                    links: document.querySelectorAll('a[href]').length,
                    buttons: document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]').length,
                    fields: document.querySelectorAll('input,select,textarea').length,
                    forms: document.forms.length,
                    images: document.images.length,
                    focusables: focusables.length
                },
                headings,
                links,
                buttons,
                fields,
                images,
                landmarks: {
                    header: document.querySelectorAll('header,[role="banner"]').length,
                    nav: document.querySelectorAll('nav,[role="navigation"]').length,
                    main: document.querySelectorAll('main,[role="main"]').length,
                    footer: document.querySelectorAll('footer,[role="contentinfo"]').length,
                    aside: document.querySelectorAll('aside,[role="complementary"]').length
                },
                accessibility: {
                    imagesMissingAlt: Array.from(document.images).filter((image) => !image.hasAttribute('alt')).length,
                    buttonsWithoutNames: buttons.length - namedButtons,
                    fieldsWithoutLabels: fields.length - labelledFields,
                    duplicateIds,
                    smallTargets
                },
                layout: {
                    viewportWidth: window.innerWidth,
                    viewportHeight: window.innerHeight,
                    scrollWidth: document.documentElement.scrollWidth,
                    scrollHeight: document.documentElement.scrollHeight,
                    clientWidth: document.documentElement.clientWidth,
                    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2
                },
                styles: {
                    bodyFontFamily: bodyStyle.fontFamily,
                    bodyFontSize: bodyStyle.fontSize,
                    bodyColor: bodyStyle.color,
                    bodyBackground: bodyStyle.backgroundColor,
                    rootColorScheme: rootStyle.colorScheme || '',
                    rootAccentColor: rootStyle.accentColor || ''
                },
                textSample: clean(document.body.innerText || '').slice(0, 2000)
            };
        }, input.maxItems || 60);

        send({ ok: true, title: await page.title(), url: page.url(), inspection, console: consoleMessages.slice(-50) });
    } catch (error) {
        send({ ok: false, error: error && error.message ? error.message : String(error), console: consoleMessages.slice(-50) });
    } finally {
        await browser.close();
    }
})().catch(error => send({ ok: false, error: error && error.message ? error.message : String(error) }));
`;

const RESPONSIVE_SCREENSHOT_SCRIPT = String.raw`
function send(value) {
    process.stdout.write(JSON.stringify(value));
}

(async () => {
    let chromium;
    try {
        chromium = require('playwright').chromium;
    } catch (error) {
        send({ ok: false, error: 'Playwright could not be loaded: ' + (error && error.message ? error.message : String(error)) });
        return;
    }

    const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
    const browser = await chromium.launch({ headless: true });
    const consoleMessages = [];
    const results = [];
    try {
        const page = await browser.newPage({ deviceScaleFactor: input.deviceScaleFactor || 1 });
        page.on('console', message => consoleMessages.push('console.' + message.type() + ': ' + message.text()));
        page.on('pageerror', error => consoleMessages.push('pageerror: ' + error.message));
        for (const shot of input.screenshots || []) {
            await page.setViewportSize({ width: shot.width, height: shot.height });
            await page.goto(input.url, { waitUntil: input.waitUntil || 'domcontentloaded', timeout: input.timeoutMs || 30000 });
            if (input.waitMs) await page.waitForTimeout(input.waitMs);
            await page.screenshot({ path: shot.path, fullPage: !!input.fullPage });
            const layout = await page.evaluate(() => ({
                scrollWidth: document.documentElement.scrollWidth,
                clientWidth: document.documentElement.clientWidth,
                scrollHeight: document.documentElement.scrollHeight,
                horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2
            }));
            results.push({ name: shot.name, width: shot.width, height: shot.height, path: shot.rel, title: await page.title(), url: page.url(), layout });
        }
        send({ ok: true, results, console: consoleMessages.slice(-50) });
    } catch (error) {
        send({ ok: false, error: error && error.message ? error.message : String(error), results, console: consoleMessages.slice(-50) });
    } finally {
        await browser.close();
    }
})().catch(error => send({ ok: false, error: error && error.message ? error.message : String(error) }));
`;

interface PageInspectInput extends ScreenshotInput {
        max_items?: number;
}

interface PageInspectionResult {
        ok: boolean;
        title?: string;
        url?: string;
        inspection?: any;
        console?: string[];
        error?: string;
}

export async function inspectWebsite(input: PageInspectInput, token: vscode.CancellationToken): Promise<PageInspectionResult> {
        const url = normalizeUrl(input);
        if (!url) return { ok: false, error: 'provide a valid http(s) url or port' };
        const timeoutMs = clampNumber(input.timeout_sec, 60, 5, 300) * 1000;
        const run = await runNpxNodeScript('playwright@1.49.1', WEBSITE_INSPECT_SCRIPT, {
                url,
                viewportWidth: clampNumber(input.viewport_width, 1280, 320, 3840),
                viewportHeight: clampNumber(input.viewport_height, 800, 320, 2160),
                deviceScaleFactor: clampNumber(input.device_scale_factor, 1, 1, 4),
                waitMs: clampNumber(input.wait_ms, 750, 0, 30000),
                timeoutMs,
                maxItems: clampNumber(input.max_items, 60, 10, 200),
        }, timeoutMs + 15000, token);
        const parsed = parseJsonOutput<PageInspectionResult>(run);
        return parsed.ok ? parsed.value : { ok: false, error: parsed.message };
}

class PageInspectTool implements vscode.LanguageModelTool<PageInspectInput> {
        async invoke(options: vscode.LanguageModelToolInvocationOptions<PageInspectInput>, token: vscode.CancellationToken) {
                const result = await inspectWebsite(options.input, token);
                if (!result.ok) return textResult(`error: page inspect failed\n${result.error ?? 'unknown error'}`);
                return textResult(JSON.stringify(result, null, 2));
        }

        async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<PageInspectInput>) {
                return { invocationMessage: `Inspecting page ${options.input.url ?? `port ${options.input.port ?? '?'}`}` };
        }
}

interface ResponsiveViewportInput { name?: string; width: number; height: number; }

interface ResponsiveScreenshotsInput extends ScreenshotInput {
        viewports?: ResponsiveViewportInput[];
        analyze?: boolean;
}

interface ResponsiveScreenshotResult {
        ok: boolean;
        results?: Array<{ name: string; width: number; height: number; path: string; title?: string; url?: string; layout?: any }>;
        console?: string[];
        error?: string;
}

function responsiveViewports(input?: ResponsiveViewportInput[]): Array<{ name: string; width: number; height: number }> {
        const source = input?.length ? input : [
                { name: 'desktop', width: 1440, height: 900 },
                { name: 'tablet', width: 834, height: 1112 },
                { name: 'mobile', width: 390, height: 844 },
        ];
        return source.slice(0, 6).map((viewport, index) => ({
                name: safeName(viewport.name || `viewport-${index + 1}`),
                width: clampNumber(viewport.width, 1280, 320, 3840),
                height: clampNumber(viewport.height, 800, 320, 2160),
        }));
}

async function captureResponsiveScreenshots(input: ResponsiveScreenshotsInput, token: vscode.CancellationToken): Promise<ResponsiveScreenshotResult> {
        const url = normalizeUrl(input);
        if (!url) return { ok: false, error: 'provide a valid http(s) url or port' };
        const viewports = responsiveViewports(input.viewports);
        const outputs = [] as Array<{ name: string; width: number; height: number; rel: string; path: string }>;
        for (const viewport of viewports) {
                const out = await workspaceOutputPath('screenshots', `responsive-${viewport.name}`, '.png', input.output_path && viewports.length === 1 ? input.output_path : undefined);
                outputs.push({ ...viewport, rel: out.rel, path: out.abs });
        }
        const timeoutMs = clampNumber(input.timeout_sec, 90, 10, 300) * 1000;
        const run = await runNpxNodeScript('playwright@1.49.1', RESPONSIVE_SCREENSHOT_SCRIPT, {
                url,
                screenshots: outputs,
                waitMs: clampNumber(input.wait_ms, 750, 0, 30000),
                timeoutMs,
                fullPage: input.full_page ?? true,
                deviceScaleFactor: clampNumber(input.device_scale_factor, 1, 1, 4),
        }, timeoutMs + 30000, token);
        const parsed = parseJsonOutput<ResponsiveScreenshotResult>(run);
        return parsed.ok ? parsed.value : { ok: false, error: parsed.message };
}

class ResponsiveScreenshotsTool implements vscode.LanguageModelTool<ResponsiveScreenshotsInput> {
        constructor(private readonly secrets: vscode.SecretStorage) {}

        async invoke(options: vscode.LanguageModelToolInvocationOptions<ResponsiveScreenshotsInput>, token: vscode.CancellationToken) {
                const planOnly = vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false;
                if (planOnly) return textResult('error: plan-only mode is enabled; responsive screenshots write files under .harmony/screenshots and are not allowed.');
                const result = await captureResponsiveScreenshots(options.input, token);
                if (!result.ok) return textResult(`error: responsive screenshots failed\n${result.error ?? 'unknown error'}`);
                const lines = [
                        '# Responsive Screenshots',
                        '',
                        ...(result.results ?? []).map(item => `- ${item.name}: ${item.width}x${item.height} -> ${item.path}${item.layout?.horizontalOverflow ? ' (horizontal overflow detected)' : ''}`),
                ];
                if (Array.isArray(result.console) && result.console.length > 0) lines.push('', 'Console messages:', ...result.console);
                if (options.input.analyze && result.results?.length) {
                        for (const item of result.results.slice(0, 3)) {
                                const abs = resolveWorkspacePath(item.path);
                                if (abs) {
                                        const note = `Responsive screenshot ${item.name} (${item.width}x${item.height}) for ${item.url ?? options.input.url ?? options.input.port}. Describe layout, overflow, text visibility, navigation, and mobile/desktop fit.`;
                                        lines.push('', `## Vision: ${item.name}`, await analyzeImageFile(abs, item.path, note, this.secrets, token));
                                }
                        }
                }
                return textResult(lines.join('\n'));
        }

        async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ResponsiveScreenshotsInput>) {
                return { invocationMessage: `Capturing responsive screenshots for ${options.input.url ?? `port ${options.input.port ?? '?'}`}` };
        }
}

interface DesignAuditInput extends PageInspectInput {
        capture_screenshots?: boolean;
}

function auditInspection(label: string, inspection: any): string[] {
        const issues: string[] = [];
        const h1Count = Array.isArray(inspection?.headings) ? inspection.headings.filter((heading: any) => heading.level === 'h1').length : 0;
        if (h1Count === 0) issues.push(`${label}: no H1 detected.`);
        if (h1Count > 1) issues.push(`${label}: multiple H1 headings detected (${h1Count}).`);
        if (!inspection?.meta?.description) issues.push(`${label}: missing meta description.`);
        if (!inspection?.meta?.viewport) issues.push(`${label}: missing viewport meta tag.`);
        if (inspection?.layout?.horizontalOverflow) issues.push(`${label}: horizontal overflow detected.`);
        if (inspection?.accessibility?.imagesMissingAlt > 0) issues.push(`${label}: ${inspection.accessibility.imagesMissingAlt} images are missing alt attributes.`);
        if (inspection?.accessibility?.buttonsWithoutNames > 0) issues.push(`${label}: ${inspection.accessibility.buttonsWithoutNames} buttons/role-buttons have no accessible name in the sampled set.`);
        if (inspection?.accessibility?.fieldsWithoutLabels > 0) issues.push(`${label}: ${inspection.accessibility.fieldsWithoutLabels} form fields have no visible/ARIA label or name in the sampled set.`);
        if (inspection?.accessibility?.duplicateIds?.length > 0) issues.push(`${label}: duplicate IDs detected: ${inspection.accessibility.duplicateIds.slice(0, 8).join(', ')}.`);
        if (inspection?.accessibility?.smallTargets > 0) issues.push(`${label}: ${inspection.accessibility.smallTargets} focusable targets are smaller than 40px in one dimension.`);
        if (inspection?.counts?.links > 80 && inspection?.counts?.headings < 3) issues.push(`${label}: many links but few headings; scanning may be difficult.`);
        return issues;
}

class DesignAuditTool implements vscode.LanguageModelTool<DesignAuditInput> {
        async invoke(options: vscode.LanguageModelToolInvocationOptions<DesignAuditInput>, token: vscode.CancellationToken) {
                const desktop = await inspectWebsite({ ...options.input, viewport_width: options.input.viewport_width ?? 1440, viewport_height: options.input.viewport_height ?? 900 }, token);
                const mobile = await inspectWebsite({ ...options.input, viewport_width: 390, viewport_height: 844 }, token);
                if (!desktop.ok && !mobile.ok) return textResult(`error: design audit failed\nDesktop: ${desktop.error ?? 'unknown'}\nMobile: ${mobile.error ?? 'unknown'}`);
                const desktopIssues = desktop.inspection ? auditInspection('desktop', desktop.inspection) : [`desktop: ${desktop.error ?? 'inspection failed'}`];
                const mobileIssues = mobile.inspection ? auditInspection('mobile', mobile.inspection) : [`mobile: ${mobile.error ?? 'inspection failed'}`];
                const issueRows = [...desktopIssues, ...mobileIssues];
                const strengths = [
                        desktop.inspection?.landmarks?.main ? 'Desktop has a main landmark.' : undefined,
                        desktop.inspection?.landmarks?.nav ? 'Desktop has navigation landmark(s).' : undefined,
                        desktop.inspection?.meta?.description ? 'Meta description is present.' : undefined,
                        mobile.inspection && !mobile.inspection.layout?.horizontalOverflow ? 'Mobile viewport has no detected horizontal overflow.' : undefined,
                ].filter(Boolean) as string[];
                const lines = [
                        '# Harmony Design Audit',
                        '',
                        `Generated: ${new Date().toISOString()}`,
                        `URL: ${desktop.url ?? mobile.url ?? options.input.url ?? options.input.port ?? '(unknown)'}`,
                        `Title: ${desktop.title ?? mobile.title ?? '(untitled)'}`,
                        '',
                        section('Strength Signals', strengths.length ? strengths : ['No strong positive signals detected in the first-pass audit.']),
                        '',
                        section('Issues / Review Points', issueRows.length ? issueRows : ['No first-pass DOM/layout issues detected. Visual review is still recommended.']),
                        '',
                        section('Recommended Next Checks', [
                                'Use responsive screenshots for visual layout review across desktop, tablet, and mobile.',
                                'Use Lighthouse for performance, accessibility, best-practices, and SEO scoring.',
                                'Use browser actions to verify forms, menus, modals, and repeated workflows.',
                                'Use a human visual pass before launch; DOM heuristics cannot judge brand polish by themselves.',
                        ]),
                ];
                const planOnly = vscode.workspace.getConfiguration('harmony').get<boolean>('planOnlyMode') ?? false;
                if (options.input.capture_screenshots) {
                        if (planOnly) {
                                lines.push('', 'Screenshot capture skipped because plan-only mode is enabled.');
                        } else {
                                const screenshots = await captureResponsiveScreenshots({ ...options.input, analyze: false }, token);
                                lines.push('', '## Screenshot Artifacts');
                                if (screenshots.ok) {
                                        lines.push(...(screenshots.results ?? []).map(item => `- ${item.name}: ${item.width}x${item.height} -> ${item.path}`));
                                } else {
                                        lines.push(`Screenshot capture failed: ${screenshots.error ?? 'unknown error'}`);
                                }
                        }
                }
                return textResult(lines.join('\n'));
        }

        async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<DesignAuditInput>) {
                return { invocationMessage: `Auditing design signals for ${options.input.url ?? `port ${options.input.port ?? '?'}`}` };
        }
}

type ImageProvider = 'gemini' | 'openai' | 'alibaba';

interface ImageGenInput {
    prompt: string;
    provider?: ImageProvider;
    model?: string;
    style?: string;
    size?: string;
    count?: number;
    output_path?: string;
}

async function confirmImageGeneration(provider: ImageProvider, model: string): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration('harmony');
    if (cfg.get<boolean>('imageGen.autoApprove')) return true;
    const choice = await vscode.window.showWarningMessage(
        `Harmony wants to generate an image with ${provider} (${model}). This may use paid image-generation quota. Allow?`,
        { modal: false },
        'Allow once', 'Always allow image gen', 'Deny'
    );
    if (choice === 'Always allow image gen') {
        await cfg.update('imageGen.autoApprove', true, vscode.ConfigurationTarget.Global);
        return true;
    }
    return choice === 'Allow once';
}

function imageTierForModel(model: string): 'light' | 'mid' | 'heavy' {
    const lower = model.toLowerCase();
    if (lower.includes('flash') || lower.includes('mini')) return 'light';
    if (lower.includes('pro') || lower.includes('dall-e-3') || lower.includes('gpt-image')) return 'mid';
    return 'mid';
}

async function geminiImage(secrets: vscode.SecretStorage, prompt: string, model: string, token: vscode.CancellationToken): Promise<{ images: Array<{ mimeType: string; base64: string }>; text: string; usage?: any }> {
    const apiKey = await secrets.get('harmony.geminiApiKey');
    if (!apiKey) throw new Error('No Gemini API key. Run "Harmony: Set Gemini API Key" from the Command Palette.');
    const allowed = await confirmPremiumModel('gemini', imageTierForModel(model), model, 'image generation');
    if (!allowed) throw new Error('user denied premium Gemini image model');
    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const body = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
        };
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal as any
        });
        const raw = await r.text();
        if (!r.ok) throw new Error(`gemini image HTTP ${r.status}: ${raw.slice(0, 1200)}`);
        const json = JSON.parse(raw);
        const parts = json?.candidates?.[0]?.content?.parts ?? [];
        const images: Array<{ mimeType: string; base64: string }> = [];
        const textParts: string[] = [];
        for (const part of parts) {
            const inlineData = part?.inlineData ?? part?.inline_data;
            if (inlineData?.data) images.push({ mimeType: inlineData.mimeType ?? inlineData.mime_type ?? 'image/png', base64: inlineData.data });
            if (typeof part?.text === 'string') textParts.push(part.text);
        }
        return { images, text: textParts.join('\n').trim(), usage: json?.usageMetadata };
    } finally {
        sub.dispose();
    }
}

async function alibabaImage(secrets: vscode.SecretStorage, prompt: string, model: string, count: number, token: vscode.CancellationToken): Promise<{ images: Array<{ mimeType: string; base64: string }>; text: string; usage?: any }> {
    const apiKey = await secrets.get('harmony.alibaba.apiKey');
    if (!apiKey) throw new Error('No Alibaba API key. Run "Harmony: Set Alibaba / Qwen API Key" from the Command Palette.');
    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());
    try {
        const url = 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/image-generation/generation';
        const body: any = {
            model,
            input: { prompt },
            parameters: { n: count, size: '1024*1024' }
        };
        const r = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'X-DashScope-Async': 'false'
            },
            body: JSON.stringify(body),
            signal: controller.signal as any
        });
        const raw = await r.text();
        if (!r.ok) throw new Error(`alibaba image HTTP ${r.status}: ${raw.slice(0, 1200)}`);
        const json = JSON.parse(raw);
        if (json?.output?.task_status === 'FAILED') {
            throw new Error(`alibaba image generation failed: ${json.output.message ?? json.output.code ?? 'unknown error'}`);
        }
        const results: any[] = json?.output?.results ?? [];
        const images: Array<{ mimeType: string; base64: string }> = [];
        for (const item of results) {
            if (item?.url) {
                const imageResponse = await fetch(item.url, { signal: controller.signal as any });
                if (!imageResponse.ok) throw new Error(`alibaba image download HTTP ${imageResponse.status}`);
                images.push({
                    mimeType: imageResponse.headers.get('content-type') ?? 'image/png',
                    base64: Buffer.from(await imageResponse.arrayBuffer()).toString('base64')
                });
            } else if (item?.b64_json) {
                images.push({ mimeType: 'image/png', base64: item.b64_json });
            }
        }
        return { images, text: '', usage: json?.usage };
    } finally {
        sub.dispose();
    }
}

async function openAiImage(secrets: vscode.SecretStorage, prompt: string, model: string, size: string, count: number, token: vscode.CancellationToken): Promise<{ images: Array<{ mimeType: string; base64: string }>; text: string }> {
    const apiKey = await secrets.get('harmony.openaiApiKey');
    if (!apiKey) throw new Error('No OpenAI API key. Run "Harmony: Set OpenAI API Key" from the Command Palette.');
    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());
    try {
        const body: any = { model, prompt, size, n: count };
        if (/^dall-e/i.test(model)) {
            body.response_format = 'b64_json';
        }
        const r = await fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify(body),
            signal: controller.signal as any
        });
        const raw = await r.text();
        if (!r.ok) throw new Error(`openai image HTTP ${r.status}: ${raw.slice(0, 1200)}`);
        const json = JSON.parse(raw);
        const images: Array<{ mimeType: string; base64: string }> = [];
        for (const item of json?.data ?? []) {
            if (item?.b64_json) {
                images.push({ mimeType: 'image/png', base64: item.b64_json });
            } else if (item?.url) {
                const imageResponse = await fetch(item.url, { signal: controller.signal as any });
                if (!imageResponse.ok) throw new Error(`openai image download HTTP ${imageResponse.status}`);
                images.push({ mimeType: imageResponse.headers.get('content-type') ?? 'image/png', base64: Buffer.from(await imageResponse.arrayBuffer()).toString('base64') });
            }
        }
        return { images, text: '' };
    } finally {
        sub.dispose();
    }
}

function estimateOpenAiImageCost(model: string, size: string, count: number): number | undefined {
    const lower = model.toLowerCase();
    if (lower.includes('dall-e-3')) {
        return count * (size === '1024x1024' ? 0.04 : 0.08);
    }
    if (lower.includes('dall-e-2')) {
        if (size === '256x256') return count * 0.016;
        if (size === '512x512') return count * 0.018;
        return count * 0.02;
    }
    return undefined;
}

export class ImageGenTool implements vscode.LanguageModelTool<ImageGenInput> {
    constructor(private readonly secrets: vscode.SecretStorage) {}

    async invoke(options: vscode.LanguageModelToolInvocationOptions<ImageGenInput>, token: vscode.CancellationToken) {
        const prompt = (options.input.prompt ?? '').trim();
        if (!prompt) return textResult('error: missing argument: prompt');
        const cfg = vscode.workspace.getConfiguration('harmony');
        const provider = options.input.provider ?? cfg.get<ImageProvider>('imageGen.provider') ?? 'gemini';
        const count = Math.max(1, Math.min(4, Number(options.input.count) || 1));
        const style = options.input.style?.trim();
        const fullPrompt = style ? `${prompt}\n\nStyle direction: ${style}` : prompt;
        try {
            let model: string;
            let generated: { images: Array<{ mimeType: string; base64: string }>; text: string; usage?: any };
            if (provider === 'gemini') {
                model = options.input.model ?? cfg.get<string>('imageGen.geminiModel') ?? 'gemini-3.1-flash-image-preview';
                if (!await confirmImageGeneration(provider, model)) return textResult('user denied image generation');
                try {
                    generated = await geminiImage(this.secrets, fullPrompt, model, token);
                } catch (error: any) {
                    const message = error?.message ?? String(error);
                    if (/HTTP 404/i.test(message) && /preview/i.test(model)) {
                        const fallbackModel = 'gemini-2.5-flash-image';
                        generated = await geminiImage(this.secrets, fullPrompt, fallbackModel, token);
                        model = fallbackModel;
                    } else {
                        throw error;
                    }
                }
                recordUsage({
                    timestamp: new Date().toISOString(),
                    provider: 'gemini',
                    tier: imageTierForModel(model),
                    model,
                    promptTokens: generated.usage?.promptTokenCount ?? 0,
                    completionTokens: generated.usage?.candidatesTokenCount ?? 0
                });
            } else if (provider === 'openai') {
                model = options.input.model ?? cfg.get<string>('imageGen.openaiModel') ?? 'dall-e-3';
                if (!await confirmImageGeneration(provider, model)) return textResult('user denied image generation');
                const safeCount = model.toLowerCase().includes('dall-e-3') ? 1 : count;
                const size = options.input.size ?? '1024x1024';
                generated = await openAiImage(this.secrets, fullPrompt, model, size, safeCount, token);
                const billableImages = generated.images.length || safeCount;
                recordUsage({
                    timestamp: new Date().toISOString(),
                    provider: 'openai',
                    tier: imageTierForModel(model),
                    model,
                    promptTokens: 0,
                    completionTokens: 0,
                    billableUnits: billableImages,
                    billableUnitLabel: 'image',
                    estimatedCostDollars: estimateOpenAiImageCost(model, size, billableImages)
                });
            } else if (provider === 'alibaba') {
                model = options.input.model ?? cfg.get<string>('imageGen.alibabaModel') ?? 'wanx-v1';
                if (!await confirmImageGeneration(provider, model)) return textResult('user denied image generation');
                generated = await alibabaImage(this.secrets, fullPrompt, model, count, token);
                const imageCount = generated.images.length || count;
                recordUsage({
                    timestamp: new Date().toISOString(),
                    provider: 'alibaba',
                    tier: imageTierForModel(model),
                    model,
                    promptTokens: 0,
                    completionTokens: 0,
                    billableUnits: imageCount,
                    billableUnitLabel: 'image'
                });
            } else {
                return textResult(`error: unsupported image provider: ${provider}`);
            }

            if (generated.images.length === 0) {
                return textResult(`error: ${provider}/${model} returned no image data${generated.text ? `\n\nProvider text:\n${generated.text}` : ''}`);
            }

            const saved: string[] = [];
            for (let i = 0; i < generated.images.length; i++) {
                const image = generated.images[i];
                const ext = extensionForMime(image.mimeType);
                const requested = generated.images.length === 1 ? options.input.output_path : undefined;
                const out = await workspaceOutputPath('assets', `generated-${i + 1}`, ext, requested);
                await fs.writeFile(out.abs, Buffer.from(image.base64, 'base64'));
                saved.push(out.rel);
            }

            const lines = [
                `Generated ${saved.length} image${saved.length === 1 ? '' : 's'} with ${provider}/${model}.`,
                ...saved.map(p => `- ${p}`)
            ];
            if (generated.text) lines.push('', 'Provider note:', generated.text);
            return textResult(lines.join('\n'));
        } catch (e: any) {
            return textResult(`error: ${e?.message ?? String(e)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ImageGenInput>) {
        const provider = options.input.provider ?? vscode.workspace.getConfiguration('harmony').get<string>('imageGen.provider') ?? 'gemini';
        return { invocationMessage: `Generating image with ${provider}` };
    }
}

interface LighthouseInput {
    url?: string;
    port?: number;
    timeout_sec?: number;
}

interface LighthouseCategory { score?: number; title?: string; }
interface LighthouseAudit { title?: string; score?: number | null; numericValue?: number; displayValue?: string; description?: string; }
interface LighthouseJson { categories?: Record<string, LighthouseCategory>; audits?: Record<string, LighthouseAudit>; finalUrl?: string; }

function scorePct(category?: LighthouseCategory): string {
    if (!category || typeof category.score !== 'number') return 'n/a';
    return `${Math.round(category.score * 100)}`;
}

export class LighthouseTool implements vscode.LanguageModelTool<LighthouseInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<LighthouseInput>, token: vscode.CancellationToken) {
        const url = normalizeUrl(options.input);
        if (!url) return textResult('error: provide a valid http(s) url or port');
        const timeoutMs = clampNumber(options.input.timeout_sec, 120, 30, 600) * 1000;
        const run = await execFile(npxCommand(), [
            '--yes',
            'lighthouse@latest',
            url,
            '--output=json',
            '--quiet',
            '--chrome-flags=--headless --no-sandbox'
        ], workspaceRoot(), timeoutMs, token);
        if (!run.ok) return textResult(`error: Lighthouse failed\n${run.error ?? ''}\n${run.stderr}\n${run.stdout}`.trim());
        const parsed = parseJsonOutput<LighthouseJson>(run);
        if (!parsed.ok) return textResult(`error: Lighthouse JSON parse failed\n${parsed.message}`);
        const json = parsed.value;
        const categories = json.categories ?? {};
        const audits = json.audits ?? {};
        const opportunities = Object.values(audits)
            .filter(a => typeof a.numericValue === 'number' && (a.score ?? 1) < 0.9)
            .sort((a, b) => (b.numericValue ?? 0) - (a.numericValue ?? 0))
            .slice(0, 8);
        const lines = [
            `Lighthouse audit for ${json.finalUrl ?? url}`,
            '',
            '| Category | Score |',
            '|---|---:|',
            `| Performance | ${scorePct(categories.performance)} |`,
            `| Accessibility | ${scorePct(categories.accessibility)} |`,
            `| Best Practices | ${scorePct(categories['best-practices'])} |`,
            `| SEO | ${scorePct(categories.seo)} |`
        ];
        if (opportunities.length > 0) {
            lines.push('', 'Top opportunities / failing audits:');
            for (const audit of opportunities) {
                lines.push(`- ${audit.title ?? 'Audit'}${audit.displayValue ? ` (${audit.displayValue})` : ''}`);
            }
        }
        return textResult(lines.join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<LighthouseInput>) {
        return { invocationMessage: `Running Lighthouse on ${options.input.url ?? `port ${options.input.port ?? '?'}`}` };
    }
}

interface BrowserDiagnoseInput {
    intent: string;
    error_message?: string;
    screenshot_path?: string;
}

class BrowserDiagnoseTool implements vscode.LanguageModelTool<BrowserDiagnoseInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<BrowserDiagnoseInput>) {
        const intent = (options.input.intent ?? '').trim();
        if (!intent) return textResult('error: intent is required');
        const errorText = (options.input.error_message ?? '').toLowerCase();
        const combined = `${intent}\n${errorText}`.toLowerCase();
        const classification = combined.includes('timeout') || combined.includes('waiting for selector') || combined.includes('locator')
            ? 'element_not_found'
            : combined.includes('navigation') || combined.includes('net::') || combined.includes('load')
                ? 'page_not_loaded'
                : combined.includes('login') || combined.includes('sign in') || combined.includes('unauthorized') || combined.includes('forbidden')
                    ? 'auth_required'
                    : combined.includes('captcha') || combined.includes('robot')
                        ? 'captcha'
                        : combined.includes('covered') || combined.includes('visible') || combined.includes('intercept') || combined.includes('layout')
                            ? 'layout_shifted'
                            : 'unknown';
        const suggestions: Record<string, string[]> = {
            element_not_found: ['Re-read the page state with a screenshot or text query.', 'Use a more stable selector such as role, label, or visible text.', 'Wait for the container that owns the target element before clicking.'],
            page_not_loaded: ['Verify the dev server URL or port.', 'Increase wait time after navigation.', 'Check console/network errors before trying the same selector again.'],
            auth_required: ['Pause and ask for sign-in or use an already authenticated browser context.', 'Avoid bypassing login or access controls.'],
            captcha: ['Stop automated interaction and ask the user to handle the challenge manually.'],
            layout_shifted: ['Capture a screenshot and inspect what overlaps the target.', 'Scroll the element into view and retry with a visible-state check.'],
            unknown: ['Capture a fresh screenshot.', 'Read visible text and console messages.', 'Try one smaller reversible browser action next.'],
        };
        return textResult(JSON.stringify({
            intent,
            screenshot_path: options.input.screenshot_path ?? null,
            failure_classification: classification,
            likely_cause: suggestions[classification][0],
            recovery_suggestions: suggestions[classification],
            needs_screenshot_review: classification === 'unknown' || classification === 'layout_shifted' || !!options.input.screenshot_path,
        }, null, 2));
    }

    async prepareInvocation() { return { invocationMessage: 'Diagnosing browser automation failure' }; }
}

interface BrowserRecipeStep {
    action: string;
    selector?: string;
    value?: string;
    description?: string;
}

interface BrowserRecipeInput {
    action: 'get' | 'save' | 'list' | 'delete';
    name?: string;
    steps?: BrowserRecipeStep[];
}

function recipeSafeName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'recipe';
}

function recipeDir(): string | undefined {
    const root = workspaceRoot();
    return root ? path.join(root, '.harmony-recipes') : undefined;
}

class BrowserRecipeTool implements vscode.LanguageModelTool<BrowserRecipeInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<BrowserRecipeInput>) {
        const dir = recipeDir();
        if (!dir) return textResult('error: no workspace folder is open');
        const action = options.input.action ?? 'list';
        await fs.mkdir(dir, { recursive: true });
        if (action === 'list') {
            const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
            const recipes = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name.replace(/\.json$/, ''));
            return textResult(JSON.stringify({ recipes }, null, 2));
        }
        const name = (options.input.name ?? '').trim();
        if (!name) return textResult(`error: ${action} requires name`);
        const file = path.join(dir, `${recipeSafeName(name)}.json`);
        if (action === 'get') {
            const content = await fs.readFile(file, 'utf8').catch(error => `error: ${error?.message ?? String(error)}`);
            return textResult(content);
        }
        if (action === 'delete') {
            await fs.rm(file, { force: true });
            return textResult(`deleted browser recipe: ${recipeSafeName(name)}`);
        }
        if (action === 'save') {
            const recipe = {
                name,
                savedAt: new Date().toISOString(),
                steps: Array.isArray(options.input.steps) ? options.input.steps : [],
            };
            await fs.writeFile(file, JSON.stringify(recipe, null, 2), 'utf8');
            return textResult(`saved browser recipe: ${file}`);
        }
        return textResult(`error: unsupported action: ${String(action)}`);
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<BrowserRecipeInput>) {
        const action = options.input.action ?? 'list';
        const base = { invocationMessage: `${action} browser recipe` };
        if (action !== 'save' && action !== 'delete') return base;
        return {
            ...base,
            confirmationMessages: {
                title: `${action === 'save' ? 'Save' : 'Delete'} browser recipe?`,
                message: new vscode.MarkdownString(`Harmony wants to ${action} a browser recipe under \`.harmony-recipes\`.`)
            }
        };
    }
}

const CSS_TRACE_SCRIPT = String.raw`
function send(value) {
    process.stdout.write(JSON.stringify(value));
}

(async () => {
    let chromium;
    try {
        chromium = require('playwright').chromium;
    } catch (error) {
        send({ ok: false, error: 'Playwright could not be loaded: ' + (error && error.message ? error.message : String(error)) });
        return;
    }

    const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
    const browser = await chromium.launch({ headless: true });
    const consoleMessages = [];
    try {
        const page = await browser.newPage({
            viewport: { width: input.viewportWidth || 1280, height: input.viewportHeight || 800 },
            deviceScaleFactor: input.deviceScaleFactor || 1
        });
        page.on('console', message => consoleMessages.push('console.' + message.type() + ': ' + message.text()));
        page.on('pageerror', error => consoleMessages.push('pageerror: ' + error.message));
        await page.goto(input.url, { waitUntil: input.waitUntil || 'domcontentloaded', timeout: input.timeoutMs || 30000 });
        if (input.waitMs) await page.waitForTimeout(input.waitMs);
        const trace = await page.evaluate((args) => {
            const element = document.querySelector(args.selector);
            if (!element) return { found: false, selector: args.selector };
            const properties = args.properties && args.properties.length ? args.properties : ['display', 'position', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'margin', 'padding', 'width', 'height', 'z-index', 'transform', 'transition', 'animation'];
            const computed = getComputedStyle(element);
            const computedValues = {};
            for (const property of properties) computedValues[property] = computed.getPropertyValue(property);
            const rect = element.getBoundingClientRect();
            const matchedRules = [];
            const inaccessibleSheets = [];
            function visitRules(rules, source, media) {
                for (const rule of Array.from(rules || [])) {
                    if (rule.cssRules) {
                        const mediaText = rule.media ? rule.media.mediaText : media;
                        visitRules(rule.cssRules, source, mediaText);
                        continue;
                    }
                    if (!rule.selectorText || !rule.style) continue;
                    let matched = false;
                    try { matched = element.matches(rule.selectorText); } catch { matched = false; }
                    if (!matched) continue;
                    const declarations = {};
                    for (const property of properties) {
                        const value = rule.style.getPropertyValue(property);
                        if (value) declarations[property] = value + (rule.style.getPropertyPriority(property) ? ' !important' : '');
                    }
                    matchedRules.push({ selector: rule.selectorText, source, media: media || '', declarations, cssText: rule.cssText.slice(0, 600) });
                }
            }
            for (const sheet of Array.from(document.styleSheets)) {
                const source = sheet.href || 'inline <style>';
                try { visitRules(sheet.cssRules, source, ''); }
                catch (error) { inaccessibleSheets.push(source); }
            }
            return {
                found: true,
                selector: args.selector,
                element: {
                    tag: element.tagName.toLowerCase(),
                    id: element.id || '',
                    className: element.className || '',
                    text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240),
                    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
                },
                computed: computedValues,
                matchedRules: matchedRules.slice(-120),
                inaccessibleSheets
            };
        }, { selector: input.selector, properties: input.properties || [] });
        send({ ok: true, title: await page.title(), url: page.url(), trace, console: consoleMessages.slice(-50) });
    } catch (error) {
        send({ ok: false, error: error && error.message ? error.message : String(error), console: consoleMessages.slice(-50) });
    } finally {
        await browser.close();
    }
})().catch(error => send({ ok: false, error: error && error.message ? error.message : String(error) }));
`;

interface CssTraceInput extends ScreenshotInput {
    selector: string;
    properties?: string[];
}

class CssTraceTool implements vscode.LanguageModelTool<CssTraceInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<CssTraceInput>, token: vscode.CancellationToken) {
        const url = normalizeUrl(options.input);
        if (!url) return textResult('error: provide a valid http(s) url or port');
        const selector = options.input.selector?.trim();
        if (!selector) return textResult('error: missing argument: selector');
        const timeoutMs = clampNumber(options.input.timeout_sec, 60, 5, 300) * 1000;
        const run = await runNpxNodeScript('playwright@1.49.1', CSS_TRACE_SCRIPT, {
            url,
            selector,
            properties: Array.isArray(options.input.properties) ? options.input.properties.slice(0, 40) : [],
            viewportWidth: clampNumber(options.input.viewport_width, 1280, 320, 3840),
            viewportHeight: clampNumber(options.input.viewport_height, 800, 320, 2160),
            deviceScaleFactor: clampNumber(options.input.device_scale_factor, 1, 1, 4),
            waitMs: clampNumber(options.input.wait_ms, 750, 0, 30000),
            timeoutMs,
        }, timeoutMs + 15000, token);
        const parsed = parseJsonOutput<any>(run);
        if (!parsed.ok) return textResult(`error: css trace failed\n${parsed.message}`);
        if (!parsed.value.ok) return textResult(`error: css trace failed\n${parsed.value.error ?? 'unknown error'}`);
        return textResult(JSON.stringify(parsed.value, null, 2));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<CssTraceInput>) {
        return { invocationMessage: `Tracing CSS for ${options.input.selector ?? '(missing selector)'}` };
    }
}

interface BrowserCompareInput {
    before_path: string;
    after_path: string;
    expected_change?: string;
    threshold?: number;
    max_sample_diffs?: number;
}

class BrowserCompareTool implements vscode.LanguageModelTool<BrowserCompareInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<BrowserCompareInput>) {
        const threshold = clampNumber(options.input.threshold, 8, 0, 255);
        const maxSamples = clampNumber(options.input.max_sample_diffs, 20, 0, 200);
        const comparison = await compareImageFiles(options.input.before_path ?? '', options.input.after_path ?? '', threshold, maxSamples);
        if (typeof comparison === 'string') return textResult(comparison);
        const expected = (options.input.expected_change ?? '').trim();
        return textResult(JSON.stringify({
            ...comparison,
            threshold,
            expected_change: expected || null,
            visual_pass: comparison.comparablePixels
                ? (expected ? (comparison.differentPixels ?? 0) > 0 : (comparison.differentPixels ?? 0) === 0)
                : comparison.beforeSha256 === comparison.afterSha256,
        }, null, 2));
    }

    async prepareInvocation() { return { invocationMessage: 'Comparing browser screenshots' }; }
}

interface VisualRegressionInput extends BrowserCompareInput {
    format?: 'markdown' | 'json';
}

class VisualRegressionTool implements vscode.LanguageModelTool<VisualRegressionInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<VisualRegressionInput>) {
        const threshold = clampNumber(options.input.threshold, 8, 0, 255);
        const maxSamples = clampNumber(options.input.max_sample_diffs, 25, 0, 200);
        const comparison = await compareImageFiles(options.input.before_path ?? '', options.input.after_path ?? '', threshold, maxSamples);
        if (typeof comparison === 'string') return textResult(comparison);
        if (options.input.format === 'json') return textResult(JSON.stringify({ ...comparison, threshold }, null, 2));
        const dimensionChange = comparison.beforeDimensions.width !== comparison.afterDimensions.width || comparison.beforeDimensions.height !== comparison.afterDimensions.height;
        const changed = dimensionChange || comparison.beforeSha256 !== comparison.afterSha256;
        const sampleRows = comparison.sampleDiffs?.slice(0, maxSamples).map(sample => `(${sample.x}, ${sample.y}) delta ${sample.delta}`) ?? [];
        return textResult([
            '# Harmony Visual Regression',
            '',
            `Before: ${comparison.beforePath}`,
            `After: ${comparison.afterPath}`,
            `Threshold: ${threshold}`,
            `Changed: ${changed ? 'yes' : 'no'}`,
            `Note: ${comparison.note}`,
            '',
            section('Dimensions', [
                `before: ${comparison.beforeDimensions.width || '?'}x${comparison.beforeDimensions.height || '?'} ${comparison.beforeDimensions.format}`,
                `after: ${comparison.afterDimensions.width || '?'}x${comparison.afterDimensions.height || '?'} ${comparison.afterDimensions.format}`,
            ]),
            '',
            comparison.comparablePixels ? section('Pixel Difference', [
                `pixels compared: ${comparison.pixelCount}`,
                `different pixels: ${comparison.differentPixels}`,
                `percent different: ${comparison.percentDifferent}%`,
                `average channel delta: ${comparison.averageChannelDelta}`,
                `max channel delta: ${comparison.maxChannelDelta}`,
            ]) : section('Pixel Difference', ['Pixel-level diff was not available; see note above.']),
            '',
            section('Sample Difference Coordinates', sampleRows.length ? sampleRows : ['No sample differences recorded.']),
            '',
            section('Review Guidance', [
                dimensionChange ? 'Dimensions changed; inspect responsive layout or screenshot capture settings first.' : 'Dimensions match.',
                comparison.comparablePixels && (comparison.percentDifferent ?? 0) > 5 ? 'Large diff detected; review screenshot visually before accepting.' : 'Diff size is small or unavailable; use expected_change context to decide pass/fail.',
            ])
        ].join('\n'));
    }

    async prepareInvocation() { return { invocationMessage: 'Running visual regression comparison' }; }
}

interface CanvasInspectInput {
    path: string;
    sample_points?: Array<{ x: number; y: number }>;
    format?: 'markdown' | 'json';
}

type CanvasAction = 'create' | 'inspect' | 'add_layer' | 'update_layer' | 'remove_layer' | 'reorder_layer' | 'undo' | 'redo' | 'render';
type CanvasLayerType = 'image' | 'text' | 'rect' | 'ellipse' | 'brush';

interface CanvasLayer {
    id: string;
    type: CanvasLayerType;
    name: string;
    visible: boolean;
    opacity: number;
    x: number;
    y: number;
    width?: number;
    height?: number;
    rotation?: number;
    source_path?: string;
    text?: string;
    font_size?: number;
    font_family?: string;
    fill?: string;
    stroke?: string;
    stroke_width?: number;
    points?: Array<{ x: number; y: number }>;
}

interface CanvasHistory {
    undo: string[];
    redo: string[];
    limit: number;
}

interface CanvasProject {
    schema: 'harmony.canvas.v1';
    id: string;
    name: string;
    created_at: string;
    updated_at: string;
    width: number;
    height: number;
    background: string;
    layers: CanvasLayer[];
    history: CanvasHistory;
    rendered_path?: string;
}

interface CanvasProjectInput {
    action?: CanvasAction;
    canvas_id?: string;
    name?: string;
    width?: number;
    height?: number;
    background?: string;
    layer?: Partial<CanvasLayer>;
    layer_id?: string;
    position?: number;
    output_path?: string;
    format?: 'markdown' | 'json';
}

function canvasRoot(): string | undefined {
    const root = workspaceRoot();
    return root ? path.join(root, '.harmony', 'canvas') : undefined;
}

function canvasPath(canvasId: string): string | undefined {
    const root = canvasRoot();
    return root ? path.join(root, safeName(canvasId), 'canvas.json') : undefined;
}

function latestCanvasPointer(): string | undefined {
    const root = canvasRoot();
    return root ? path.join(root, 'latest-canvas.json') : undefined;
}

async function latestCanvasId(): Promise<string | undefined> {
    const pointer = latestCanvasPointer();
    if (!pointer) return undefined;
    try {
        const parsed = JSON.parse(await fs.readFile(pointer, 'utf8')) as { id?: string };
        return parsed.id;
    } catch {
        return undefined;
    }
}

async function resolveCanvasId(inputId?: string): Promise<string | undefined> {
    return inputId?.trim() || await latestCanvasId();
}

async function loadCanvas(inputId?: string): Promise<CanvasProject | undefined> {
    const id = await resolveCanvasId(inputId);
    if (!id) return undefined;
    const target = canvasPath(id);
    if (!target) return undefined;
    try { return JSON.parse(await fs.readFile(target, 'utf8')) as CanvasProject; } catch { return undefined; }
}

async function saveCanvas(canvas: CanvasProject): Promise<string> {
    const target = canvasPath(canvas.id);
    const pointer = latestCanvasPointer();
    if (!target || !pointer) throw new Error('no workspace folder is open');
    canvas.updated_at = new Date().toISOString();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.mkdir(path.dirname(pointer), { recursive: true });
    await fs.writeFile(target, JSON.stringify(canvas, null, 2), 'utf8');
    await fs.writeFile(pointer, JSON.stringify({ id: canvas.id, path: workspaceRel(target), updated_at: canvas.updated_at }, null, 2), 'utf8');
    return workspaceRel(target);
}

function workspaceRel(absPath: string): string {
    const root = workspaceRoot();
    return root ? path.relative(root, absPath).replace(/\\/g, '/') : absPath;
}

async function saveCanvasSnapshot(canvas: CanvasProject, stack: 'undo' | 'redo'): Promise<string> {
    const root = canvasRoot();
    if (!root) throw new Error('no workspace folder is open');
    const dir = path.join(root, safeName(canvas.id), 'history');
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${stack}-${timestampSlug()}.json`);
    await fs.writeFile(target, JSON.stringify(canvas, null, 2), 'utf8');
    return workspaceRel(target);
}

async function pushUndoSnapshot(canvas: CanvasProject): Promise<void> {
    const snapshot = await saveCanvasSnapshot(canvas, 'undo');
    canvas.history.undo.push(snapshot);
    canvas.history.redo = [];
    while (canvas.history.undo.length > canvas.history.limit) canvas.history.undo.shift();
}

async function readCanvasSnapshot(relPath: string): Promise<CanvasProject | undefined> {
    const abs = resolveWorkspacePath(relPath);
    if (!abs) return undefined;
    try { return JSON.parse(await fs.readFile(abs, 'utf8')) as CanvasProject; } catch { return undefined; }
}

function normalizeLayer(input: Partial<CanvasLayer>, fallbackIndex: number): CanvasLayer {
    const type = (['image', 'text', 'rect', 'ellipse', 'brush'].includes(String(input.type)) ? input.type : 'rect') as CanvasLayerType;
    return {
        id: safeName(input.id || input.name || `layer-${fallbackIndex}`),
        type,
        name: input.name || `${type} ${fallbackIndex}`,
        visible: input.visible !== false,
        opacity: Math.max(0, Math.min(Number(input.opacity ?? 1), 1)),
        x: Math.floor(Number(input.x ?? 0)),
        y: Math.floor(Number(input.y ?? 0)),
        width: input.width === undefined ? undefined : Math.max(0, Math.floor(Number(input.width))),
        height: input.height === undefined ? undefined : Math.max(0, Math.floor(Number(input.height))),
        rotation: input.rotation === undefined ? undefined : Number(input.rotation),
        source_path: input.source_path,
        text: input.text,
        font_size: input.font_size === undefined ? undefined : Math.max(1, Math.floor(Number(input.font_size))),
        font_family: input.font_family,
        fill: input.fill,
        stroke: input.stroke,
        stroke_width: input.stroke_width === undefined ? undefined : Math.max(0, Number(input.stroke_width)),
        points: Array.isArray(input.points) ? input.points.map(point => ({ x: Number(point.x), y: Number(point.y) })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y)) : undefined,
    };
}

function mergeLayer(existing: CanvasLayer, patch: Partial<CanvasLayer>): CanvasLayer {
    return normalizeLayer({ ...existing, ...patch, id: existing.id }, 1);
}

async function renderCanvasSvg(canvas: CanvasProject, outputPath?: string): Promise<string> {
    const root = workspaceRoot();
    if (!root) throw new Error('no workspace folder is open');
    const defaultRel = path.posix.join('.harmony', 'canvas', safeName(canvas.id), `${safeName(canvas.name)}.svg`);
    const rel = normalizeWorkspaceRel((outputPath && outputPath.trim()) || defaultRel);
    const abs = resolveWorkspacePath(rel);
    if (!abs) throw new Error(`output path is outside workspace: ${rel}`);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const body: string[] = [
        `<rect x="0" y="0" width="${canvas.width}" height="${canvas.height}" fill="${escapeXml(canvas.background)}"/>`,
    ];
    for (const layer of canvas.layers.filter(item => item.visible !== false)) {
        const opacity = Math.max(0, Math.min(layer.opacity ?? 1, 1));
        const transform = layer.rotation ? ` transform="rotate(${layer.rotation} ${layer.x} ${layer.y})"` : '';
        if (layer.type === 'rect') {
            body.push(`<rect id="${escapeXml(layer.id)}" x="${layer.x}" y="${layer.y}" width="${layer.width ?? 100}" height="${layer.height ?? 100}" fill="${escapeXml(layer.fill ?? '#ffffff')}" stroke="${escapeXml(layer.stroke ?? 'none')}" stroke-width="${layer.stroke_width ?? 0}" opacity="${opacity}"${transform}/>`);
        } else if (layer.type === 'ellipse') {
            const width = layer.width ?? 100;
            const height = layer.height ?? 100;
            body.push(`<ellipse id="${escapeXml(layer.id)}" cx="${layer.x + width / 2}" cy="${layer.y + height / 2}" rx="${width / 2}" ry="${height / 2}" fill="${escapeXml(layer.fill ?? '#ffffff')}" stroke="${escapeXml(layer.stroke ?? 'none')}" stroke-width="${layer.stroke_width ?? 0}" opacity="${opacity}"${transform}/>`);
        } else if (layer.type === 'text') {
            body.push(`<text id="${escapeXml(layer.id)}" x="${layer.x}" y="${layer.y}" font-size="${layer.font_size ?? 24}" font-family="${escapeXml(layer.font_family ?? 'serif')}" fill="${escapeXml(layer.fill ?? '#111111')}" opacity="${opacity}"${transform}>${escapeXml(layer.text ?? '')}</text>`);
        } else if (layer.type === 'brush') {
            const points = (layer.points ?? []).map(point => `${point.x},${point.y}`).join(' ');
            body.push(`<polyline id="${escapeXml(layer.id)}" points="${escapeXml(points)}" fill="none" stroke="${escapeXml(layer.stroke ?? layer.fill ?? '#111111')}" stroke-width="${layer.stroke_width ?? 4}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"${transform}/>`);
        } else if (layer.type === 'image' && layer.source_path) {
            const sourceAbs = resolveWorkspacePath(layer.source_path);
            const href = sourceAbs ? path.relative(path.dirname(abs), sourceAbs).replace(/\\/g, '/') : layer.source_path;
            let width = layer.width;
            let height = layer.height;
            if (sourceAbs && (!width || !height)) {
                const buffer = await fs.readFile(sourceAbs).catch(() => undefined);
                const dimensions = buffer ? imageDimensions(buffer) : undefined;
                width = width || dimensions?.width || 100;
                height = height || dimensions?.height || 100;
            }
            body.push(`<image id="${escapeXml(layer.id)}" href="${escapeXml(href)}" x="${layer.x}" y="${layer.y}" width="${width ?? 100}" height="${height ?? 100}" opacity="${opacity}"${transform}/>`);
        }
    }
    const svg = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}" role="img" aria-label="${escapeXml(canvas.name)}">`,
        ...body,
        '</svg>',
    ].join('\n');
    await fs.writeFile(abs, svg, 'utf8');
    return rel;
}

function formatCanvas(canvas: CanvasProject, writtenPath?: string, message?: string): string {
    return [
        '# Harmony Canvas Project',
        '',
        message,
        `Canvas: ${canvas.id}`,
        `Name: ${canvas.name}`,
        `Size: ${canvas.width}x${canvas.height}`,
        `Background: ${canvas.background}`,
        `Layers: ${canvas.layers.length}`,
        `Undo snapshots: ${canvas.history.undo.length}`,
        `Redo snapshots: ${canvas.history.redo.length}`,
        writtenPath ? `Written: ${writtenPath}` : undefined,
        canvas.rendered_path ? `Rendered: ${canvas.rendered_path}` : undefined,
        '',
        section('Layer Stack', canvas.layers.map((layer, index) => `${index + 1}. ${layer.id} (${layer.type}) ${layer.visible ? 'visible' : 'hidden'} opacity=${layer.opacity}`)),
    ].filter(Boolean).join('\n');
}

class CanvasProjectTool implements vscode.LanguageModelTool<CanvasProjectInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<CanvasProjectInput>) {
        const action = options.input.action ?? 'inspect';
        const root = workspaceRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const run = async () => {
            if (action === 'create') {
                const now = new Date().toISOString();
                const canvas: CanvasProject = {
                    schema: 'harmony.canvas.v1',
                    id: safeName(options.input.canvas_id || options.input.name || `canvas-${timestampSlug()}`),
                    name: options.input.name || 'Harmony canvas',
                    created_at: now,
                    updated_at: now,
                    width: clampNumber(options.input.width, 1024, 1, 20000),
                    height: clampNumber(options.input.height, 1024, 1, 20000),
                    background: options.input.background || 'transparent',
                    layers: [],
                    history: { undo: [], redo: [], limit: 50 },
                };
                if (options.input.layer) canvas.layers.push(normalizeLayer(options.input.layer, 1));
                const written = await saveCanvas(canvas);
                return { canvas, written, message: 'Created canvas project.' };
            }

            const canvas = await loadCanvas(options.input.canvas_id);
            if (!canvas) throw new Error(`canvas not found: ${options.input.canvas_id ?? 'latest'}`);
            if (action === 'inspect') return { canvas, message: 'Loaded canvas project.' };
            if (action === 'render') {
                const rendered = await renderCanvasSvg(canvas, options.input.output_path);
                canvas.rendered_path = rendered;
                const written = await saveCanvas(canvas);
                return { canvas, written, message: `Rendered SVG: ${rendered}` };
            }
            await pushUndoSnapshot(canvas);
            if (action === 'add_layer') {
                if (!options.input.layer) throw new Error('add_layer requires layer');
                canvas.layers.push(normalizeLayer(options.input.layer, canvas.layers.length + 1));
            } else if (action === 'update_layer') {
                const index = canvas.layers.findIndex(layer => layer.id === options.input.layer_id);
                if (index < 0) throw new Error(`layer not found: ${options.input.layer_id ?? ''}`);
                canvas.layers[index] = mergeLayer(canvas.layers[index], options.input.layer ?? {});
            } else if (action === 'remove_layer') {
                const before = canvas.layers.length;
                canvas.layers = canvas.layers.filter(layer => layer.id !== options.input.layer_id);
                if (canvas.layers.length === before) throw new Error(`layer not found: ${options.input.layer_id ?? ''}`);
            } else if (action === 'reorder_layer') {
                const index = canvas.layers.findIndex(layer => layer.id === options.input.layer_id);
                if (index < 0) throw new Error(`layer not found: ${options.input.layer_id ?? ''}`);
                const [layer] = canvas.layers.splice(index, 1);
                const position = Math.max(0, Math.min((options.input.position ?? canvas.layers.length + 1) - 1, canvas.layers.length));
                canvas.layers.splice(position, 0, layer);
            } else if (action === 'undo') {
                const snapshotRel = canvas.history.undo.pop();
                if (!snapshotRel) throw new Error('nothing to undo');
                const redoRel = await saveCanvasSnapshot(canvas, 'redo');
                const previous = await readCanvasSnapshot(snapshotRel);
                if (!previous) throw new Error(`could not read undo snapshot: ${snapshotRel}`);
                previous.history.undo = canvas.history.undo;
                previous.history.redo = [...canvas.history.redo, redoRel];
                const written = await saveCanvas(previous);
                return { canvas: previous, written, message: `Restored undo snapshot: ${snapshotRel}` };
            } else if (action === 'redo') {
                const snapshotRel = canvas.history.redo.pop();
                if (!snapshotRel) throw new Error('nothing to redo');
                const undoRel = await saveCanvasSnapshot(canvas, 'undo');
                const next = await readCanvasSnapshot(snapshotRel);
                if (!next) throw new Error(`could not read redo snapshot: ${snapshotRel}`);
                next.history.undo = [...canvas.history.undo, undoRel];
                next.history.redo = canvas.history.redo;
                const written = await saveCanvas(next);
                return { canvas: next, written, message: `Restored redo snapshot: ${snapshotRel}` };
            } else {
                throw new Error(`unsupported canvas action: ${action}`);
            }
            const written = await saveCanvas(canvas);
            return { canvas, written, message: `Canvas action completed: ${action}` };
        };

        try {
            const lockId = `canvas:${options.input.canvas_id ?? 'latest'}`;
            const result = action === 'inspect'
                ? await run()
                : await withOperationLock(root, lockId, `canvas ${action}`, { action, canvas_id: options.input.canvas_id }, run);
            if (options.input.format === 'json') return textResult(JSON.stringify(result, null, 2));
            return textResult(formatCanvas(result.canvas, result.written, result.message));
        } catch (error) {
            return textResult(`error: ${(error as Error)?.message ?? String(error)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<CanvasProjectInput>) {
        return { invocationMessage: `Canvas ${options.input.action ?? 'inspect'}${options.input.canvas_id ? `: ${options.input.canvas_id}` : ''}` };
    }
}

type RasterOperationType = 'fill_rect' | 'erase_rect' | 'brush' | 'crop' | 'resize';

interface RasterOperation {
    type: RasterOperationType;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    color?: string;
    size?: number;
    points?: Array<{ x: number; y: number }>;
}

interface RasterEditInput {
    input_path?: string;
    output_path?: string;
    width?: number;
    height?: number;
    background?: string;
    operations?: RasterOperation[];
    format?: 'markdown' | 'json';
}

function createBlankRaster(width: number, height: number, background: RgbaColor): DecodedPng {
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < rgba.length; i += 4) {
        rgba[i] = background.r;
        rgba[i + 1] = background.g;
        rgba[i + 2] = background.b;
        rgba[i + 3] = background.a;
    }
    return { width, height, rgba };
}

function fillRect(raster: DecodedPng, op: RasterOperation, color: RgbaColor): void {
    const startX = Math.max(0, Math.floor(Number(op.x ?? 0)));
    const startY = Math.max(0, Math.floor(Number(op.y ?? 0)));
    const endX = Math.min(raster.width, startX + Math.max(0, Math.floor(Number(op.width ?? raster.width))));
    const endY = Math.min(raster.height, startY + Math.max(0, Math.floor(Number(op.height ?? raster.height))));
    for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) blendPixel(raster.rgba, raster.width, x, y, color);
    }
}

function drawCircle(raster: DecodedPng, centerX: number, centerY: number, radius: number, color: RgbaColor): void {
    const minX = Math.max(0, Math.floor(centerX - radius));
    const maxX = Math.min(raster.width - 1, Math.ceil(centerX + radius));
    const minY = Math.max(0, Math.floor(centerY - radius));
    const maxY = Math.min(raster.height - 1, Math.ceil(centerY + radius));
    const radiusSquared = radius * radius;
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const dx = x - centerX;
            const dy = y - centerY;
            if (dx * dx + dy * dy <= radiusSquared) blendPixel(raster.rgba, raster.width, x, y, color);
        }
    }
}

function drawBrush(raster: DecodedPng, op: RasterOperation, color: RgbaColor): void {
    const points = (op.points ?? []).filter(point => Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)));
    const radius = Math.max(1, Number(op.size ?? 8) / 2);
    for (let index = 0; index < points.length; index++) {
        const current = points[index];
        const previous = points[index - 1] ?? current;
        const dx = current.x - previous.x;
        const dy = current.y - previous.y;
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(1, radius)));
        for (let step = 0; step <= steps; step++) {
            const t = step / steps;
            drawCircle(raster, previous.x + dx * t, previous.y + dy * t, radius, color);
        }
    }
}

function cropRaster(raster: DecodedPng, op: RasterOperation): DecodedPng {
    const startX = Math.max(0, Math.min(raster.width - 1, Math.floor(Number(op.x ?? 0))));
    const startY = Math.max(0, Math.min(raster.height - 1, Math.floor(Number(op.y ?? 0))));
    const width = Math.max(1, Math.min(raster.width - startX, Math.floor(Number(op.width ?? raster.width - startX))));
    const height = Math.max(1, Math.min(raster.height - startY, Math.floor(Number(op.height ?? raster.height - startY))));
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const sourceStart = ((startY + y) * raster.width + startX) * 4;
        const targetStart = y * width * 4;
        rgba.set(raster.rgba.subarray(sourceStart, sourceStart + width * 4), targetStart);
    }
    return { width, height, rgba };
}

function resizeRaster(raster: DecodedPng, op: RasterOperation): DecodedPng {
    const width = Math.max(1, Math.min(20000, Math.floor(Number(op.width ?? raster.width))));
    const height = Math.max(1, Math.min(20000, Math.floor(Number(op.height ?? raster.height))));
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const sourceY = Math.min(raster.height - 1, Math.floor((y / height) * raster.height));
        for (let x = 0; x < width; x++) {
            const sourceX = Math.min(raster.width - 1, Math.floor((x / width) * raster.width));
            const source = (sourceY * raster.width + sourceX) * 4;
            const target = (y * width + x) * 4;
            rgba[target] = raster.rgba[source];
            rgba[target + 1] = raster.rgba[source + 1];
            rgba[target + 2] = raster.rgba[source + 2];
            rgba[target + 3] = raster.rgba[source + 3];
        }
    }
    return { width, height, rgba };
}

class RasterEditTool implements vscode.LanguageModelTool<RasterEditInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<RasterEditInput>) {
        const root = workspaceRoot();
        if (!root) return textResult('error: no workspace folder is open');
        const operations = Array.isArray(options.input.operations) ? options.input.operations : [];
        try {
            return await withOperationLock(root, 'raster-edit', 'raster edit', { input_path: options.input.input_path, output_path: options.input.output_path, operations: operations.length }, async () => {
                let raster: DecodedPng;
                if (options.input.input_path) {
                    const inputAbs = resolveWorkspacePath(options.input.input_path);
                    if (!inputAbs) return textResult(`error: input_path is outside workspace: ${options.input.input_path}`);
                    const decoded = decodePng(await fs.readFile(inputAbs));
                    if (!decoded) return textResult('error: raster editing currently supports non-interlaced 8-bit RGB/RGBA PNG input only.');
                    raster = { width: decoded.width, height: decoded.height, rgba: new Uint8Array(decoded.rgba) };
                } else {
                    const width = clampNumber(options.input.width, 1024, 1, 20000);
                    const height = clampNumber(options.input.height, 1024, 1, 20000);
                    raster = createBlankRaster(width, height, parseColor(options.input.background, { r: 0, g: 0, b: 0, a: 0 }));
                }
                const applied: string[] = [];
                for (const op of operations) {
                    if (op.type === 'fill_rect') {
                        fillRect(raster, op, parseColor(op.color, { r: 0, g: 0, b: 0, a: 255 }));
                    } else if (op.type === 'erase_rect') {
                        fillRect(raster, op, { r: 0, g: 0, b: 0, a: 0 });
                    } else if (op.type === 'brush') {
                        drawBrush(raster, op, parseColor(op.color, { r: 0, g: 0, b: 0, a: 255 }));
                    } else if (op.type === 'crop') {
                        raster = cropRaster(raster, op);
                    } else if (op.type === 'resize') {
                        raster = resizeRaster(raster, op);
                    } else {
                        return textResult(`error: unsupported raster operation: ${(op as RasterOperation).type}`);
                    }
                    applied.push(op.type);
                }
                const output = await workspaceOutputPath('raster', 'raster-edit', '.png', options.input.output_path);
                await fs.writeFile(output.abs, encodePng(raster.width, raster.height, raster.rgba));
                const payload = {
                    output_path: output.rel,
                    width: raster.width,
                    height: raster.height,
                    operations_applied: applied,
                    bytes: (await fs.stat(output.abs)).size,
                    sha256: sha256Buffer(await fs.readFile(output.abs)),
                };
                if (options.input.format === 'json') return textResult(JSON.stringify(payload, null, 2));
                return textResult([
                    '# Harmony Raster Edit',
                    '',
                    `Output: ${payload.output_path}`,
                    `Size: ${payload.width}x${payload.height}`,
                    `Operations: ${payload.operations_applied.length ? payload.operations_applied.join(', ') : '(none)'}`,
                    `SHA256: ${payload.sha256.slice(0, 16)}`,
                ].join('\n'));
            });
        } catch (error) {
            return textResult(`error: ${(error as Error)?.message ?? String(error)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<RasterEditInput>) {
        return {
            invocationMessage: `Raster editing ${options.input.input_path ?? 'new PNG'}`,
            confirmationMessages: {
                title: 'Write raster image?',
                message: new vscode.MarkdownString(`Harmony wants to write a PNG raster edit${options.input.output_path ? ` to \`${options.input.output_path}\`` : ' under `.harmony/raster`'}.`)
            }
        };
    }
}

function rgbaAt(image: DecodedPng, x: number, y: number): { r: number; g: number; b: number; a: number } | undefined {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return undefined;
    const offset = (y * image.width + x) * 4;
    return { r: image.rgba[offset], g: image.rgba[offset + 1], b: image.rgba[offset + 2], a: image.rgba[offset + 3] };
}

class CanvasInspectTool implements vscode.LanguageModelTool<CanvasInspectInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<CanvasInspectInput>) {
        const requestedPath = (options.input.path ?? '').trim();
        if (!requestedPath) return textResult('error: missing argument: path');
        const resolved = resolveWorkspacePath(requestedPath);
        if (!resolved) return textResult(`error: path is outside workspace: ${requestedPath}`);
        const buffer = await fs.readFile(resolved).catch(() => undefined);
        if (!buffer) return textResult(`error: could not read image: ${requestedPath}`);
        const dimensions = imageDimensions(buffer);
        const decoded = decodePng(buffer);
        const defaultSamples = dimensions.width && dimensions.height ? [
            { x: 0, y: 0 },
            { x: Math.floor(dimensions.width / 2), y: Math.floor(dimensions.height / 2) },
            { x: Math.max(0, dimensions.width - 1), y: Math.max(0, dimensions.height - 1) },
        ] : [];
        const samplePoints = (options.input.sample_points?.length ? options.input.sample_points : defaultSamples).slice(0, 25)
            .map(point => ({ x: Math.floor(Number(point.x)), y: Math.floor(Number(point.y)) }));
        const samples = decoded ? samplePoints.map(point => ({ ...point, rgba: rgbaAt(decoded, point.x, point.y) ?? null })) : [];
        let alphaPixels = 0;
        if (decoded) {
            for (let i = 3; i < decoded.rgba.length; i += 4) if (decoded.rgba[i] < 255) alphaPixels++;
        }
        const payload = {
            path: requestedPath,
            bytes: buffer.length,
            sha256: sha256Buffer(buffer),
            mimeType: mimeTypeForPath(requestedPath),
            dimensions,
            decodedPng: !!decoded,
            hasAlpha: decoded ? alphaPixels > 0 : undefined,
            alphaPixels: decoded ? alphaPixels : undefined,
            samples,
            note: decoded ? 'PNG decoded locally; samples are RGBA values.' : 'Metadata only. Pixel samples require a supported non-interlaced 8-bit RGB/RGBA PNG.',
        };
        if (options.input.format === 'json') return textResult(JSON.stringify(payload, null, 2));
        return textResult([
            '# Harmony Canvas Inspect',
            '',
            `Path: ${payload.path}`,
            `Bytes: ${payload.bytes}`,
            `SHA256: ${payload.sha256.slice(0, 16)}`,
            `Dimensions: ${dimensions.width || '?'}x${dimensions.height || '?'} ${dimensions.format}`,
            `Decoded PNG: ${payload.decodedPng ? 'yes' : 'no'}`,
            decoded ? `Has alpha: ${payload.hasAlpha ? 'yes' : 'no'} (${alphaPixels} non-opaque pixel${alphaPixels === 1 ? '' : 's'})` : '',
            '',
            section('Samples', samples.length ? samples.map(sample => `${sample.x},${sample.y}: ${sample.rgba ? `rgba(${sample.rgba.r}, ${sample.rgba.g}, ${sample.rgba.b}, ${sample.rgba.a})` : 'outside image'}`) : ['No pixel samples available.']),
            '',
            payload.note,
        ].filter(Boolean).join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<CanvasInspectInput>) {
        return { invocationMessage: `Inspecting image canvas: ${options.input.path ?? ''}` };
    }
}

interface ImageDiffInput extends VisualRegressionInput {}

class ImageDiffTool implements vscode.LanguageModelTool<ImageDiffInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<ImageDiffInput>) {
        const tool = new VisualRegressionTool();
        return tool.invoke(options);
    }

    async prepareInvocation() { return { invocationMessage: 'Diffing local images' }; }
}

interface MaskPreviewInput {
    mask_path: string;
    threshold?: number;
    format?: 'markdown' | 'json';
}

class MaskPreviewTool implements vscode.LanguageModelTool<MaskPreviewInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<MaskPreviewInput>) {
        const requestedPath = (options.input.mask_path ?? '').trim();
        if (!requestedPath) return textResult('error: missing argument: mask_path');
        const resolved = resolveWorkspacePath(requestedPath);
        if (!resolved) return textResult(`error: path is outside workspace: ${requestedPath}`);
        const buffer = await fs.readFile(resolved).catch(() => undefined);
        if (!buffer) return textResult(`error: could not read mask image: ${requestedPath}`);
        const decoded = decodePng(buffer);
        if (!decoded) return textResult('error: mask_preview currently supports non-interlaced 8-bit RGB/RGBA PNG masks only.');
        const threshold = clampNumber(options.input.threshold, 1, 0, 255);
        let activePixels = 0;
        let minX = decoded.width;
        let minY = decoded.height;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < decoded.height; y++) {
            for (let x = 0; x < decoded.width; x++) {
                const offset = (y * decoded.width + x) * 4;
                const alpha = decoded.rgba[offset + 3];
                const luminance = Math.round((decoded.rgba[offset] + decoded.rgba[offset + 1] + decoded.rgba[offset + 2]) / 3);
                if (alpha > threshold && luminance > threshold) {
                    activePixels++;
                    minX = Math.min(minX, x);
                    minY = Math.min(minY, y);
                    maxX = Math.max(maxX, x);
                    maxY = Math.max(maxY, y);
                }
            }
        }
        const totalPixels = decoded.width * decoded.height;
        const payload = {
            maskPath: requestedPath,
            width: decoded.width,
            height: decoded.height,
            threshold,
            activePixels,
            coveragePercent: Number(((activePixels / totalPixels) * 100).toFixed(4)),
            boundingBox: activePixels ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
            note: 'Mask preview is analytic only; no image was modified or written.',
        };
        if (options.input.format === 'json') return textResult(JSON.stringify(payload, null, 2));
        return textResult([
            '# Harmony Mask Preview',
            '',
            `Mask: ${payload.maskPath}`,
            `Dimensions: ${payload.width}x${payload.height}`,
            `Threshold: ${payload.threshold}`,
            `Active pixels: ${payload.activePixels}`,
            `Coverage: ${payload.coveragePercent}%`,
            `Bounding box: ${payload.boundingBox ? `${payload.boundingBox.x},${payload.boundingBox.y} ${payload.boundingBox.width}x${payload.boundingBox.height}` : '(none)'}`,
            '',
            payload.note,
        ].join('\n'));
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<MaskPreviewInput>) {
        return { invocationMessage: `Previewing mask: ${options.input.mask_path ?? ''}` };
    }
}

export function registerVisualTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.lm.registerTool('harmony_screenshot', new ScreenshotTool(context.secrets)),
        vscode.lm.registerTool('harmony_browser_action', new BrowserActionTool(context.secrets)),
        vscode.lm.registerTool('harmony_browser_health', new BrowserHealthTool()),
        vscode.lm.registerTool('harmony_page_inspect', new PageInspectTool()),
        vscode.lm.registerTool('harmony_responsive_screenshots', new ResponsiveScreenshotsTool(context.secrets)),
        vscode.lm.registerTool('harmony_design_audit', new DesignAuditTool()),
        vscode.lm.registerTool('harmony_visual_regression', new VisualRegressionTool()),
        vscode.lm.registerTool('harmony_css_trace', new CssTraceTool()),
        vscode.lm.registerTool('harmony_canvas_inspect', new CanvasInspectTool()),
        vscode.lm.registerTool('harmony_canvas_project', new CanvasProjectTool()),
        vscode.lm.registerTool('harmony_raster_edit', new RasterEditTool()),
        vscode.lm.registerTool('harmony_image_diff', new ImageDiffTool()),
        vscode.lm.registerTool('harmony_mask_preview', new MaskPreviewTool()),
        vscode.lm.registerTool('harmony_image_gen', new ImageGenTool(context.secrets)),
        vscode.lm.registerTool('harmony_vision_read', new VisionReadTool(context.secrets)),
        vscode.lm.registerTool('harmony_lighthouse', new LighthouseTool()),
        vscode.lm.registerTool('harmony_browser_diagnose', new BrowserDiagnoseTool()),
        vscode.lm.registerTool('harmony_browser_recipe', new BrowserRecipeTool()),
        vscode.lm.registerTool('harmony_browser_compare', new BrowserCompareTool()),
        vscode.lm.registerTool('harmony_ocr', new OcrTool()),
    );
}

// ── OCR (Optical Character Recognition) ────────────────────────

interface OcrInput {
    path: string;
    fallback_vision?: boolean;
}

export class OcrTool implements vscode.LanguageModelTool<OcrInput> {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<OcrInput>, token: vscode.CancellationToken) {
        const requestedPath = (options.input.path ?? '').trim();
        if (!requestedPath) return textResult('error: missing argument: path');
        const resolved = resolveWorkspacePath(requestedPath);
        if (!resolved) return textResult(`error: path is outside workspace: ${requestedPath}`);

        try {
            const stat = await fs.stat(resolved);
            if (!stat.isFile()) return textResult(`error: path is not a file: ${requestedPath}`);
            if (stat.size > 20 * 1024 * 1024) return textResult(`error: image too large (${Math.round(stat.size / 1024 / 1024)} MB). Max 20 MB.`);
        } catch {
            return textResult(`error: cannot access file: ${requestedPath}`);
        }

        // Run Windows OCR via Python script
        const scriptPath = path.join(__dirname, '..', 'scripts', 'ocr_text.py');
        try {
            const result = cp.execSync(`python "${scriptPath}" "${resolved}"`, {
                encoding: 'utf-8',
                timeout: 30000,
                maxBuffer: 1024 * 1024,
            });
            const parsed = JSON.parse(result.trim());
            if (parsed.ok && parsed.text) {
                const confidenceLabel = parsed.confidence === 'high' ? 'HIGH confidence'
                    : parsed.confidence === 'medium' ? 'MEDIUM confidence'
                    : parsed.confidence === 'low' ? 'LOW confidence (verify accuracy)'
                    : 'UNKNOWN confidence';
                const lines = [`[Windows OCR — ${confidenceLabel}]`, '', parsed.text, '',
                    `Lines: ${parsed.line_count ?? '?'} | Words: ${parsed.word_count ?? '?'} | Language: ${parsed.language ?? '?'}`];
                if (parsed.confidence === 'low' || parsed.confidence === 'medium') {
                    lines.push('', 'Tip: For low/medium confidence results, call harmony_vision_read for cross-check.');
                }
                return textResult(lines.join('\n'));
            }
            // OCR ran but found no text or failed
            const hint = parsed.hint || parsed.error || 'OCR found no text';
            return textResult(`[Windows OCR — NO TEXT FOUND]\n\n${hint}\n\nTip: Call harmony_vision_read for AI vision analysis instead.`);
        } catch (e: any) {
            const errMsg = e?.message ?? String(e);
            return textResult(`[Windows OCR — FAILED]\n\n${errMsg}\n\nTip: Windows OCR requires the 'winrt' Python package and an OCR language pack. Call harmony_vision_read for AI vision analysis as fallback.`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<OcrInput>) {
        return { invocationMessage: `Extracting text via OCR: ${options.input.path}` };
    }
}

interface VisionReadInput {
    path: string;
    prompt?: string;
}

export class VisionReadTool implements vscode.LanguageModelTool<VisionReadInput> {
    constructor(private readonly secrets: vscode.SecretStorage) {}

    async invoke(options: vscode.LanguageModelToolInvocationOptions<VisionReadInput>, token: vscode.CancellationToken) {
        const requestedPath = (options.input.path ?? '').trim();
        if (!requestedPath) return textResult('error: missing argument: path');
        const resolved = resolveWorkspacePath(requestedPath);
        if (!resolved) return textResult(`error: path is outside workspace: ${requestedPath}`);
        try {
            const stat = await fs.stat(resolved);
            if (!stat.isFile()) return textResult(`error: path is not a file: ${requestedPath}`);
            if (stat.size > 20 * 1024 * 1024) return textResult(`error: image is too large for inline vision routing (${Math.round(stat.size / 1024 / 1024)} MB). Use an image under 20 MB.`);
            const note = (options.input.prompt ?? '').trim() || 'Describe this local image. If it is a UI screenshot, transcribe visible text and call out layout, spacing, colors, and obvious defects.';
            return textResult(await analyzeImageFile(resolved, requestedPath, note, this.secrets, token));
        } catch (error: any) {
            return textResult(`error: ${error?.message ?? String(error)}`);
        }
    }

    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<VisionReadInput>) {
        return { invocationMessage: `Reading image visually: ${options.input.path}` };
    }
}