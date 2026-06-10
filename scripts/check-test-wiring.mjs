#!/usr/bin/env node
/**
 * Guard: every workspace package that contains test files must have a
 * `test` script in its package.json, otherwise `turbo test` silently
 * skips it and the suite never runs in CI (this happened to
 * @ifc-lite/ifcx and @ifc-lite/renderer — 13 test files dark for months).
 *
 * Run via `pnpm check:test-wiring` (wired into the CI node-test job).
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_DIRS = ['packages', 'apps'];
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|mts|js|mjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'pkg', 'build', 'coverage', '.turbo']);

function findTestFiles(dir, found = []) {
  if (found.length > 0) return found; // one hit is enough
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      findTestFiles(full, found);
      if (found.length > 0) return found;
    } else if (TEST_FILE_RE.test(entry)) {
      found.push(full);
      return found;
    }
  }
  return found;
}

const offenders = [];

for (const parent of PACKAGE_DIRS) {
  const parentDir = join(ROOT, parent);
  if (!existsSync(parentDir)) continue;
  for (const name of readdirSync(parentDir)) {
    const pkgDir = join(parentDir, name);
    const pkgJsonPath = join(pkgDir, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    if (pkgJson.scripts?.test) continue;
    const testFiles = findTestFiles(pkgDir);
    if (testFiles.length > 0) {
      offenders.push({ name: pkgJson.name ?? `${parent}/${name}`, example: testFiles[0].slice(ROOT.length + 1) });
    }
  }
}

if (offenders.length > 0) {
  console.error('❌ Packages with test files but no `test` script (these tests NEVER run in CI):\n');
  for (const { name, example } of offenders) {
    console.error(`   ${name}  (e.g. ${example})`);
  }
  console.error('\nAdd a `test` script to the package.json (vitest run / tsx --test) or remove the dead test files.');
  process.exit(1);
}

console.log('✅ All packages with test files have a test script.');
