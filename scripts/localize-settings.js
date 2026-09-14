#!/usr/bin/env node
'use strict';

// One-shot migration: move every contributes.configuration setting `description`
// and `enumDescriptions` entry out of package.json into VS Code NLS placeholders
// (%key%), and emit an EN map for translation.
//
//   node scripts/localize-settings.js           # dry run (no writes)
//   node scripts/localize-settings.js --apply   # rewrite package.json + package.nls.json
//
// Only the `contributes.configuration` block is touched. Tool inputSchema
// descriptions are model-facing and intentionally left alone.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const enNlsPath = path.join(root, 'package.nls.json');
const apply = process.argv.includes('--apply');

const text = fs.readFileSync(pkgPath, 'utf8');

const marker = '"configuration": {';
const startIdx = text.indexOf(marker);
if (startIdx < 0) throw new Error('configuration block not found');

const blockStart = startIdx + marker.length - 1; // points at '{'
let depth = 0;
let inStr = false;
let esc = false;
let endIdx = -1;
for (let i = blockStart; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { endIdx = i; break; }
    }
}
if (endIdx < 0) throw new Error('could not find end of configuration block');

const eol = text.includes('\r\n') ? '\r\n' : '\n';
const blockText = text.slice(blockStart, endIdx + 1);
const lines = blockText.split(eol);

const en = {};
const outLines = [];
let current = null;
let inEnum = false;
let enumIndex = 0;

const settingRe = /^        "([A-Za-z0-9._]+)": \{$/;
const enumOpenRe = /^          "enumDescriptions": \[$/;
const enumCloseRe = /^          \],?$/;
const enumItemRe = /^(            )("(?:[^"\\]|\\.)*")(,?)$/;
const descRe = /^(          "description": )("(?:[^"\\]|\\.)*")(,?)$/;

for (const line of lines) {
    const settingMatch = line.match(settingRe);
    if (settingMatch) {
        current = settingMatch[1];
        inEnum = false;
        outLines.push(line);
        continue;
    }

    if (!inEnum && enumOpenRe.test(line)) {
        inEnum = true;
        enumIndex = 0;
        outLines.push(line);
        continue;
    }

    if (inEnum) {
        if (enumCloseRe.test(line)) { inEnum = false; outLines.push(line); continue; }
        const itemMatch = line.match(enumItemRe);
        if (itemMatch && current) {
            const key = `config.${current}.enum.${enumIndex}`;
            en[key] = JSON.parse(itemMatch[2]);
            outLines.push(`${itemMatch[1]}"%${key}%"${itemMatch[3]}`);
            enumIndex += 1;
            continue;
        }
        outLines.push(line);
        continue;
    }

    const descMatch = line.match(descRe);
    if (descMatch && current) {
        const key = `config.${current}.description`;
        en[key] = JSON.parse(descMatch[2]);
        outLines.push(`${descMatch[1]}"%${key}%"${descMatch[3]}`);
        continue;
    }

    outLines.push(line);
}

const newBlock = outLines.join(eol);
const newText = text.slice(0, blockStart) + newBlock + text.slice(endIdx + 1);

const keys = Object.keys(en);
const descCount = keys.filter((k) => k.endsWith('.description')).length;
const enumCount = keys.length - descCount;
const leftover = (newBlock.match(/"description": "(?!%)/g) || []).length;

console.log(`Extracted ${keys.length} strings (${descCount} descriptions, ${enumCount} enum items)`);
console.log(`Leftover inline descriptions in block: ${leftover}`);

if (apply) {
    const enNls = JSON.parse(fs.readFileSync(enNlsPath, 'utf8'));
    const merged = { ...enNls, ...en };
    fs.writeFileSync(pkgPath, newText, 'utf8');
    fs.writeFileSync(enNlsPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    fs.mkdirSync(path.join(root, '.harmony', 'nls'), { recursive: true });
    fs.writeFileSync(
        path.join(root, '.harmony', 'nls', 'settings-en.json'),
        `${JSON.stringify(en, null, 2)}\n`,
        'utf8'
    );
    console.log(`APPLIED: package.json + package.nls.json (${Object.keys(merged).length} keys) + .harmony/nls/settings-en.json`);
} else {
    console.log('DRY RUN (no files written). Re-run with --apply.');
}
