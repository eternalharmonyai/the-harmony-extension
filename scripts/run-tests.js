// Test runner for node:test + TypeScript via tsx
// Finds all .test.ts files and runs them
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const testDir = path.join(__dirname, '..', 'src', 'primitives', '__tests__');
const files = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.test.ts'))
  .map(f => path.join('src', 'primitives', '__tests__', f));

console.log(`Found ${files.length} test files\n`);

const cmd = `npx tsx --test ${files.join(' ')}`;
try {
  execSync(cmd, { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
} catch (e) {
  process.exit(e.status || 1);
}
