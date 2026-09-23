#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5236: a live query/write that walks the parsed base table can return a
 * deleted entity or miss one created in the mutation overlay. Compare every
 * production raw-access site against the merge base, so a new site fails even
 * while the already-filed instances are being moved to effective accessors.
 * An intentional raw read needs `@raw-entity-enumeration-ok <reason>` directly
 * above its statement; those exceptions are printed on every run.
 *
 * This is deliberately a conservative AST ratchet, not proof that a guarded
 * call site applies the overlay. It sees dot-property reads of
 * `entityIndex.byType`, `entityIndex.byId`, and `entities.count` across every
 * production package and the viewer. Parser/build-time raw reads remain in
 * the census, but a new one needs an explicit reason. It does not follow
 * aliases, bracket-property access, or calls into another package. The real
 * behavior remains pinned by tests.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRawEntityAccess, excessRawAccess, changedPathBaselines } from './lib/raw-entity-enumeration.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCAN_ROOTS = [
  ...readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, 'packages', entry.name, 'src')))
    .map((entry) => `packages/${entry.name}/src`),
  'apps/viewer/src',
];

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !/(?:\.test|\.spec|\.d)\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function main() {
  const base = git('merge-base', 'origin/main', 'HEAD');
  // A rename preserves the site's old budget. Read its old content through
  // the source path, but fingerprint it under the destination path.
  const changedFiles = changedPathBaselines(git('diff', '--name-status', '-M', base, '--', ...SCAN_ROOTS));
  for (const path of git('ls-files', '--others', '--exclude-standard', '--', ...SCAN_ROOTS).split('\n')) {
    if (path) changedFiles.set(path, null);
  }
  let totalBase = 0;
  let totalCurrent = 0;
  let scannedFiles = 0;
  const newSites = [];
  const exceptions = [];
  for (const root of SCAN_ROOTS) {
    const fullRoot = join(ROOT, root);
    if (!existsSync(fullRoot)) throw new Error(`Missing scan root: ${root}`);
    const files = sourceFiles(fullRoot);
    if (files.length === 0) throw new Error(`No production TypeScript files under scan root: ${root}`);
    for (const fullPath of files) {
      scannedFiles++;
      const path = relative(ROOT, fullPath).replaceAll('\\', '/');
      const text = readFileSync(fullPath, 'utf8');
      const current = scanRawEntityAccess(path, text);
      if (current.length === 0) continue;
      let before = current;
      if (changedFiles.has(path)) {
        let oldText = '';
        const source = changedFiles.get(path);
        if (source) oldText = git('show', `${base}:${source}`);
        before = oldText ? scanRawEntityAccess(path, oldText) : [];
      }
      totalBase += before.length;
      totalCurrent += current.length;
      newSites.push(...excessRawAccess(before, current));
      exceptions.push(...current.filter((hit) => hit.reason).map((hit) => `${path}:${hit.line}: ${hit.reason}`));
    }
  }
  for (const exception of exceptions) console.log(`raw-access exception: ${exception}`);
  if (newSites.length > 0) {
    for (const hit of newSites) console.error(`NEW raw entity access: ${hit.key} at line ${hit.line}`);
    console.error('Route live-session queries through an effective-entity accessor, or document an intentional raw read with @raw-entity-enumeration-ok.');
    process.exitCode = 1;
  } else {
    console.log(`check-raw-entity-enumeration: OK (${scannedFiles} source files, ${totalCurrent} current raw-access sites checked against their file baselines; ${exceptions.length} explicit exceptions)`);
  }
}

main();
