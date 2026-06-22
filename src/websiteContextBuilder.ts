import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { inspectWebsite } from './visualTools';

/**
 * Web source types for the website-analysis pipeline.
 */
export type WebsiteSourceType = 'url' | 'folder' | 'current-file';

/**
 * Build a structured Markdown context payload for the website-analysis pipeline.
 * @param target - URL string, folder path, or empty for current file
 * @param sourceType - 'url', 'folder', or 'current-file'
 * @param token - CancellationToken
 * @returns Structured Markdown string to feed into `{website_context}` prompt placeholder
 */
export async function buildWebsiteContext(
    target: string,
    sourceType: WebsiteSourceType,
    token: vscode.CancellationToken
): Promise<{ context: string; sourceLabel: string }> {
    if (sourceType === 'url' && target) {
        return gatherFromUrl(target, token);
    }
    if (sourceType === 'folder' && target) {
        return gatherFromFolder(target);
    }
    // current-file: use active editor
    return gatherFromCurrentFile();
}

// ── URL: Playwright-powered context ─────────────────────────────

async function gatherFromUrl(
    url: string,
    token: vscode.CancellationToken
): Promise<{ context: string; sourceLabel: string }> {
    // Normalize URL
    let normalized = url.trim();
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
        normalized = `https://${normalized}`;
    }

    try {
        const result = await inspectWebsite(
            {
                url: normalized,
                viewport_width: 1440,
                viewport_height: 900,
                wait_ms: 1000,
                timeout_sec: 30,
                max_items: 80,
            },
            token
        );

        if (!result.ok || !result.inspection) {
            return {
                context: `# Website Analysis Context\n\n## Target URL\n${normalized}\n\n⚠️ **Failed to inspect page:** ${result.error || 'Unknown error'}\n\nConsole output:\n\`\`\`\n${(result.console || []).join('\n')}\n\`\`\`\n`,
                sourceLabel: `🌐 ${normalized} (inspection failed)`,
            };
        }

        const insp = result.inspection;
        const context = formatPlaywrightContext(normalized, insp, result.console || []);
        return { context, sourceLabel: `🌐 ${normalized}` };
    } catch (err: any) {
        return {
            context: `# Website Analysis Context\n\n## Target URL\n${normalized}\n\n❌ **Playwright error:** ${err?.message || String(err)}\n`,
            sourceLabel: `🌐 ${normalized} (error)`,
        };
    }
}

function formatPlaywrightContext(url: string, insp: any, consoleMsgs: string[]): string {
    const parts: string[] = [];

    parts.push('# WEBSITE ANALYSIS CONTEXT');
    parts.push(`\n## Target URL\n${url}`);
    parts.push(`\n**Title:** ${insp.title || 'N/A'}`);
    parts.push(`**Language:** ${insp.lang || 'not set'}`);

    // Meta
    if (insp.meta) {
        parts.push('\n## Meta Tags');
        if (insp.meta.description) parts.push(`- **Description:** ${insp.meta.description}`);
        if (insp.meta.viewport) parts.push(`- **Viewport:** ${insp.meta.viewport}`);
        if (insp.meta.canonical) parts.push(`- **Canonical:** ${insp.meta.canonical}`);
        if (!insp.meta.description && !insp.meta.viewport) parts.push('_No meta tags found_');
    }

    // Counts
    if (insp.counts) {
        parts.push('\n## Page Structure (Counts)');
        const c = insp.counts;
        parts.push(`- Headings: ${c.headings} | Links: ${c.links} | Buttons: ${c.buttons}`);
        parts.push(`- Forms: ${c.forms} | Fields: ${c.fields} | Images: ${c.images}`);
        parts.push(`- Focusable elements: ${c.focusables}`);
    }

    // Headings hierarchy
    if (insp.headings?.length) {
        parts.push('\n## Heading Hierarchy');
        for (const h of insp.headings) {
            parts.push(`- **${h.level}:** ${h.text}`);
        }
    }

    // Links
    if (insp.links?.length) {
        parts.push(`\n## Links (${insp.links.length} shown)`);
        for (const l of insp.links.slice(0, 30)) {
            parts.push(`- [${l.text}](${l.href})`);
        }
        if (insp.links.length > 30) parts.push(`_... and ${insp.links.length - 30} more_`);
    }

    // Buttons
    if (insp.buttons?.length) {
        parts.push(`\n## Buttons & Interactive Elements (${insp.buttons.length} shown)`);
        for (const b of insp.buttons.slice(0, 30)) {
            const dims = b.width && b.height ? ` (${b.width}×${b.height}px)` : '';
            const state = b.disabled ? ' [DISABLED]' : '';
            parts.push(`- **${b.name || '(unnamed)'}** \`${b.tag}\`${dims}${state}`);
        }
    }

    // Forms & Fields
    if (insp.fields?.length) {
        parts.push(`\n## Form Fields (${insp.fields.length} shown)`);
        for (const f of insp.fields.slice(0, 20)) {
            const req = f.required ? ' *required*' : '';
            parts.push(`- **${f.label || f.name || '(unlabeled)'}** \`${f.tag}\` type=${f.type}${req}`);
        }
    }

    // Images
    if (insp.images?.length) {
        parts.push(`\n## Images (${insp.images.length} shown)`);
        let missingAlt = 0;
        for (const img of insp.images.slice(0, 20)) {
            if (!img.alt) missingAlt++;
            const alt = img.alt ? `alt="${img.alt.slice(0, 80)}"` : '⚠️ NO ALT TEXT';
            const dims = img.width && img.height ? ` ${img.width}×${img.height}` : '';
            parts.push(`- ${alt}${dims}`);
        }
        parts.push(`\n**Images missing alt text:** ${missingAlt}/${Math.min(insp.images.length, 20)} shown`);
    }

    // Accessibility
    if (insp.accessibility) {
        parts.push('\n## Accessibility Snapshot');
        const a = insp.accessibility;
        parts.push(`- Images missing alt: ${a.imagesMissingAlt ?? '?'}`);
        parts.push(`- Buttons without names: ${a.buttonsWithoutNames ?? '?'}`);
        parts.push(`- Fields without labels: ${a.fieldsWithoutLabels ?? '?'}`);
        parts.push(`- Small touch targets (<40px): ${a.smallTargets ?? '?'}`);
        if (a.duplicateIds?.length) {
            parts.push(`- ⚠️ Duplicate IDs: ${a.duplicateIds.join(', ')}`);
        }
    }

    // Landmarks
    if (insp.landmarks) {
        parts.push('\n## ARIA Landmarks');
        const lm = insp.landmarks;
        parts.push(`- header: ${lm.header} | nav: ${lm.nav} | main: ${lm.main} | footer: ${lm.footer} | aside: ${lm.aside}`);
    }

    // Layout
    if (insp.layout) {
        parts.push('\n## Layout');
        const l = insp.layout;
        parts.push(`- Viewport: ${l.viewportWidth}×${l.viewportHeight}`);
        parts.push(`- Content: ${l.scrollWidth}×${l.scrollHeight}`);
        parts.push(`- Horizontal overflow: ${l.horizontalOverflow ? '⚠️ YES' : '✅ No'}`);
    }

    // Styles
    if (insp.styles) {
        parts.push('\n## Computed Styles (body)');
        const s = insp.styles;
        if (s.bodyFontFamily) parts.push(`- Font: ${s.bodyFontFamily}`);
        if (s.bodyFontSize) parts.push(`- Font size: ${s.bodyFontSize}`);
        if (s.bodyColor) parts.push(`- Text color: ${s.bodyColor}`);
        if (s.bodyBackground) parts.push(`- Background: ${s.bodyBackground}`);
        if (s.rootColorScheme) parts.push(`- Color scheme: ${s.rootColorScheme}`);
    }

    // Text sample
    if (insp.textSample) {
        parts.push('\n## Page Text Sample (first 2000 chars)');
        parts.push('```');
        parts.push(insp.textSample);
        parts.push('```');
    }

    // Console
    if (consoleMsgs.length) {
        parts.push('\n## Browser Console');
        parts.push('```');
        parts.push(consoleMsgs.slice(-20).join('\n'));
        parts.push('```');
    }

    return parts.join('\n');
}

// ── Local folder: static file gathering ─────────────────────────

const WEBSITE_EXTENSIONS = new Set([
    '.html', '.htm', '.css', '.scss', '.less',
    '.js', '.ts', '.jsx', '.tsx', '.mjs',
    '.json', '.md', '.txt',
]);

const SKIP_DIRS = new Set([
    'node_modules', '.git', '.harmony', 'dist', 'build',
    '.next', 'out', 'coverage', '__pycache__',
]);

async function gatherFromFolder(
    folderPath: string
): Promise<{ context: string; sourceLabel: string }> {
    const parts: string[] = [];
    parts.push('# WEBSITE ANALYSIS CONTEXT');
    parts.push(`\n## Source: Local Folder\n**Path:** ${folderPath}`);

    try {
        const files = collectWebsiteFiles(folderPath, 80);
        if (!files.length) {
            parts.push('\n⚠️ No website files (.html, .css, .js, .md) found in this folder.');
            return { context: parts.join('\n'), sourceLabel: `📁 ${path.basename(folderPath)} (no files)` };
        }

        parts.push(`\n## Files Gathered (${files.length})`);
        for (const file of files) {
            parts.push(`- ${file.relativePath} (${file.size.toLocaleString()} bytes)`);
        }

        for (const file of files) {
            parts.push(`\n---\n### 📄 ${file.relativePath}\n\`\`\`${file.extension.slice(1)}`);
            try {
                const content = fs.readFileSync(file.absolutePath, 'utf-8');
                // Truncate large files
                if (content.length > 15000) {
                    parts.push(content.slice(0, 15000));
                    parts.push(`\n... [truncated, ${(content.length - 15000).toLocaleString()} more chars]`);
                } else {
                    parts.push(content);
                }
            } catch {
                parts.push(`[Error reading file]`);
            }
            parts.push('```');
        }
    } catch (err: any) {
        parts.push(`\n❌ **Error gathering files:** ${err?.message || String(err)}`);
    }

    return { context: parts.join('\n'), sourceLabel: `📁 ${path.basename(folderPath)}` };
}

interface GatheredFile {
    relativePath: string;
    absolutePath: string;
    extension: string;
    size: number;
}

function collectWebsiteFiles(rootPath: string, maxFiles: number): GatheredFile[] {
    const results: GatheredFile[] = [];

    function walk(dir: string) {
        if (results.length >= maxFiles) return;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (results.length >= maxFiles) return;
                if (entry.isDirectory()) {
                    if (SKIP_DIRS.has(entry.name)) continue;
                    if (entry.name.startsWith('.')) continue;
                    walk(path.join(dir, entry.name));
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (WEBSITE_EXTENSIONS.has(ext)) {
                        const abs = path.join(dir, entry.name);
                        try {
                            const stat = fs.statSync(abs);
                            results.push({
                                relativePath: path.relative(rootPath, abs),
                                absolutePath: abs,
                                extension: ext,
                                size: stat.size,
                            });
                        } catch {
                            // skip unreadable files
                        }
                    }
                }
            }
        } catch {
            // skip unreadable directories
        }
    }

    walk(rootPath);

    // Prioritize HTML files, then CSS, then JS, then others
    const priorityOrder: Record<string, number> = {
        '.html': 1, '.htm': 1,
        '.css': 2, '.scss': 2, '.less': 2,
        '.js': 3, '.ts': 3, '.jsx': 3, '.tsx': 3, '.mjs': 3,
        '.json': 4, '.md': 4, '.txt': 4,
    };

    results.sort((a, b) => {
        const pa = priorityOrder[a.extension] ?? 5;
        const pb = priorityOrder[b.extension] ?? 5;
        return pa - pb || a.relativePath.localeCompare(b.relativePath);
    });

    return results.slice(0, maxFiles);
}

// ── Current file fallback ───────────────────────────────────────

function gatherFromCurrentFile(): { context: string; sourceLabel: string } {
    const editor = vscode.window.activeTextEditor;
    const content = editor?.document.getText() ?? '';
    const fileName = editor ? path.basename(editor.document.fileName) : 'unknown';

    const parts: string[] = [];
    parts.push('# WEBSITE ANALYSIS CONTEXT');
    parts.push(`\n## Source: Current File`);
    parts.push(`**File:** ${fileName}`);
    parts.push(`\n\`\`\``);
    parts.push(content || '_(empty file)_');
    parts.push('```');

    if (!content) {
        parts.push('\n⚠️ **Warning:** No file content available. The analysis will be hypothetical. For best results, provide a URL or folder path.');
    }

    return { context: parts.join('\n'), sourceLabel: `📄 ${fileName}` };
}
