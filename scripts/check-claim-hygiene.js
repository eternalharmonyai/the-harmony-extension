#!/usr/bin/env node
'use strict';
/**
 * Gate: Release Copy & Claim Hygiene Check (Editorial / Technical QA Lint ONLY — Not Legal Advice)
 *
 * Ensures public-facing documentation, localization strings, and UI labels maintain
 * accurate, engineering-grounded terminology:
 *  1. Avoids financial-warranty feature titles ("Cost Shield", "费用护盾", "成本护盾") in favor of
 *     mechanism-grounded "Context Shield" / "上下文护盾".
 *  2. Avoids third-party persona brand collisions ("Sovereign Gems", "Gems Sanctuary",
 *     or browser DOM scraper URLs targeting gemini.google.com) in favor of "Prism Sanctuary".
 *  3. Avoids overstated technical absolutes ("RAPT-proof", "partial writes are impossible",
 *     "without data loss", "no other AI coding collaborator offers today").
 *  4. Verifies prominent top-of-README user billing responsibility & non-affiliation notices.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function check(label, ok, detail) {
    if (ok) {
        passed++;
        console.log('  PASS  ' + label);
    } else {
        failed++;
        console.error('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
    }
}

const DOC_AND_LOCALE_FILES = [
    'README.md',
    'README.zh-CN.md',
    'release-notes-v0.4.17.md',
    'release-notes-v0.4.17.zh.md',
    'locales/en.json',
    'locales/zh.json',
    'package.json',
    'package.nls.json',
    'package.nls.zh-cn.json',
];

const UI_AND_SOURCE_FILES = [
    'src/prismSanctuary.ts',
    'src/gemSanctuary.ts',
    'src/vertexAuth.ts',
    'src/providerModels.ts',
    'src/sidebar.ts',
    'src/extension.ts',
    'src/chatParticipant.ts',
    'src/host/standaloneServer.ts',
    'src/host/studioSettings.ts',
    'scripts/extract-gemini-gems.js',
];

const FORBIDDEN_PATTERNS = [
    { label: 'no "Cost Shield" financial-warranty heading/label', re: /\bCost\s+Shield\b|\bCost-Shield\b|\bCOST[- ]SHIELD\b/ },
    { label: 'no Chinese "费用护盾 / 成本护盾" label', re: /费用护盾|成本护盾/ },
    { label: 'no "Sovereign Gems" / "Gems Sanctuary" branding', re: /\bSovereign[- ]Gems?\b|\bGems?\s+Sanctuary\b|主权\s*Gems?\s*圣殿/i },
    { label: 'no third-party gemini.google.com scraper URL', re: /gemini\.google\.com\/(?:app\/)?gems/i },
    { label: 'no "RAPT-proof" circumvention/warranty phrasing', re: /RAPT[- ]proof|免\s*RAPT\s*过期|防\s*RAPT\s*过期/i },
    { label: 'no "partial writes are impossible / without data loss" absolute', re: /partial writes are impossible|without data loss|no data loss|部分写入不可能发生|不可能出现部分写入|不会丢失数据/i },
    { label: 'no "no other AI coding ... offers today" comparative claim', re: /no other AI coding (?:collaborator|assistant) offers today/i },
];

function stripLineCommentsInCode(raw, isCodeFile) {
    if (!isCodeFile) return raw;
    return raw
        .split('\n')
        .map((line) => (/^\s*\/\//.test(line) ? '' : line))
        .join('\n');
}

console.log('\n[check:claim-hygiene] Running editorial & release-copy hygiene checks...\n');

for (const rel of [...DOC_AND_LOCALE_FILES, ...UI_AND_SOURCE_FILES]) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
        check(`${rel} exists`, false, 'missing file');
        continue;
    }
    const rawText = fs.readFileSync(abs, 'utf8');
    const isCode = rel.endsWith('.ts') || rel.endsWith('.js');
    // On prismSanctuary.ts & gemSanctuary.ts, inspect comments too so docblocks stay clean!
    const inspectCommentsToo = rel === 'src/prismSanctuary.ts' || rel === 'src/gemSanctuary.ts';
    const text = stripLineCommentsInCode(rawText, isCode && !inspectCommentsToo);
    for (const rule of FORBIDDEN_PATTERNS) {
        const hit = rule.re.exec(text);
        if (hit) {
            const lineNum = text.slice(0, hit.index).split('\n').length;
            check(`${rel}: ${rule.label}`, false, `found "${hit[0]}" at line ${lineNum}`);
        } else {
            passed++;
        }
    }
}

const readmeEnPath = path.join(ROOT, 'README.md');
const readmeZhPath = path.join(ROOT, 'README.zh-CN.md');
if (fs.existsSync(readmeEnPath) && fs.existsSync(readmeZhPath)) {
    const readmeEn = fs.readFileSync(readmeEnPath, 'utf8');
    const readmeZh = fs.readFileSync(readmeZhPath, 'utf8');
    const topEn = readmeEn.slice(0, 2600);
    const topZh = readmeZh.slice(0, 2200);

    check(
        'README.md top banner includes upfront User Billing & Provider Terms Responsibility + Hippocratic License 3.0',
        topEn.includes('User Billing & Provider Terms Responsibility') &&
            topEn.includes('Hippocratic License 3.0') &&
            topEn.includes('Context Shield')
    );
    check(
        'README.zh-CN.md top banner includes upfront billing responsibility + Hippocratic License 3.0',
        topZh.includes('用户计费与服务商条款责任声明') &&
            topZh.includes('Hippocratic License 3.0') &&
            topZh.includes('上下文护盾')
    );
    check(
        'README.md includes Third-Party Trademarks & Non-Affiliation notice',
        readmeEn.includes('Third-Party Trademarks & Non-Affiliation') &&
            readmeEn.includes('not affiliated with, endorsed by, or sponsored by')
    );
    check(
        'README.zh-CN.md includes Third-Party Trademarks & Non-Affiliation notice',
        readmeZh.includes('第三方商标与非关联声明') &&
            readmeZh.includes('无隶属、背书或赞助关系')
    );
}

const sidebarSrc = fs.readFileSync(path.join(ROOT, 'src', 'sidebar.ts'), 'utf8');
check(
    'Concert Board preserves lastConcertData across Phase 3 refreshes and guards __concertBoardEnriched',
    sidebarSrc.includes('private lastConcertData:') &&
        sidebarSrc.includes('Promise.resolve(this.lastConcertData)') &&
        sidebarSrc.includes('if (!window.__concertBoardEnriched || hasEnrichedIncoming)')
);

const locEn = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8'));
const locZh = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'zh.json'), 'utf8'));
check(
    'Sidebar billing responsibility notice & Context Shield card are localized in both locales/en.json and locales/zh.json',
    Boolean(locEn['usage.responsibilityNoticeHtml']) &&
        locEn['usage.responsibilityNoticeHtml'].includes('UNOFFICIAL ESTIMATE ONLY') &&
        Boolean(locZh['usage.responsibilityNoticeHtml']) &&
        locZh['usage.responsibilityNoticeHtml'].includes('非官方估算') &&
        locZh['usage.responsibilityNoticeHtml'].includes('上下文护盾') &&
        Boolean(locEn['contextShield.title']) &&
        Boolean(locZh['contextShield.title']) &&
        sidebarSrc.includes("lm.getString('usage.responsibilityNoticeHtml')") &&
        sidebarSrc.includes("lm.getString('contextShield.title')")
);

if (failed > 0) {
    console.error(`\n[check:claim-hygiene] FAILED (${failed} failed, ${passed} passed)\n`);
    process.exit(1);
}
console.log(`\n[check:claim-hygiene] ALL ${passed} CHECKS PASSED\n`);
