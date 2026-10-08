#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6962 perf-flag lint (CI: test.yml node-tests).
 *
 *   - The registry (apps/viewer/src/lib/perf/flags.ts): every flag has an
 *     owner and a removal condition, and no ramp is more than four weeks past
 *     its `introducedAt`.
 *   - Ratchet: a `__IFC_LITE_*` global is read only by the registry, the
 *     shared reader in @ifc-lite/data, and geometry's binding declarations.
 *     Tests and the benchmark harness (which injects the globals) are exempt.
 *
 * Usage: node scripts/check-perf-flags.mjs [--today YYYY-MM-DD]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRegistry, findPerfGlobalReads } from './lib/perf-flag-lint.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const REGISTRY_PATH = 'apps/viewer/src/lib/perf/flags.ts';
/** The only production files allowed to name a `__IFC_LITE_*` global. */
export const ALLOWED_READERS = new Set([
  REGISTRY_PATH,
  'packages/data/src/perf-flag-reader.ts',
  'packages/geometry/src/perf-flags.ts',
]);
/**
 * `__IFC_LITE_*` names the viewer PUBLISHES for harnesses (outputs it writes),
 * not flags it reads. They are not perf flags, so they are not registry entries.
 */
export const PUBLISHED_GLOBALS = new Set([
  '__IFC_LITE_LOAD_TRACE__', // load-trace span API, apps/viewer/src/lib/perf/loadTraceEnabled.ts (#6956)
]);
// Production sources only: the viewer and every package's src/ (other apps
// and package tooling never read these flags).
const SCAN_ROOTS = ['apps/viewer/src', 'packages/*/src'];
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const EXEMPT = [
  /(?:^|\/)tests?\//,
  /(?:^|\/)__tests__\//,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /\.d\.[cm]?ts$/,
  /(?:^|\/)(?:dist|pkg|node_modules)\//,
];

export function isScanned(path) {
  return SOURCE.test(path) && !ALLOWED_READERS.has(path) && !EXEMPT.some((re) => re.test(path));
}

function parseToday(argv) {
  const i = argv.indexOf('--today');
  if (i === -1) return new Date();
  const date = new Date(`${argv[i + 1]}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`--today expects YYYY-MM-DD, got ${argv[i + 1]}`);
  return date;
}

function main() {
  const today = parseToday(process.argv.slice(2));
  const problems = checkRegistry(readFileSync(join(ROOT, REGISTRY_PATH), 'utf8'), { today, fileName: REGISTRY_PATH });
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', ...SCAN_ROOTS.map((root) => `:(glob)${root}/**`)], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((path) => path && isScanned(path));
  if (files.length === 0) throw new Error('check-perf-flags: no source files scanned (wrong cwd?)');
  for (const path of files) {
    let text;
    try {
      text = readFileSync(join(ROOT, path), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue; // tracked but deleted in the working tree
      throw error;
    }
    if (!text.includes('__IFC_LITE_')) continue;
    for (const hit of findPerfGlobalReads(text, path)) {
      if (PUBLISHED_GLOBALS.has(hit.name)) continue;
      problems.push(`${path}:${hit.line}: reads ${hit.name} directly; go through readPerfFlag (viewer) or readPerfFlagRaw (packages)`);
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(`check-perf-flags: ${problems.length} problem(s). See ${REGISTRY_PATH}.`);
    process.exitCode = 1;
    return;
  }
  console.log(`check-perf-flags: OK (registry valid; ${files.length} production files free of direct __IFC_LITE_* reads)`);
}

if (isMainEntry(import.meta.url)) main();
