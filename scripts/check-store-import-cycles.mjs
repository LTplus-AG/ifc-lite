#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Guard the viewer store entry against reachable source modules importing it back. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORE_ENTRY = 'apps/viewer/src/store/index.ts';
const ALLOWLIST = 'scripts/store-import-cycle-allowlist.txt';

function imports(source) {
  const result = [];
  const from = /\b(import|export)\s+([\s\S]*?)\sfrom\s*(['"])([^'"]+)\3/g;
  for (const match of source.matchAll(from)) {
    if (/^\s*type(?:\s+[\w$]+)?\s*$|^\s*type\s*[{*]/.test(match[2])) continue;
    result.push(match[4]);
  }
  const sideEffect = /\bimport\s*(['"])([^'"]+)\1/g;
  for (const match of source.matchAll(sideEffect)) result.push(match[2]);
  return result;
}

function resolveModule(specifier, importer, root) {
  if (specifier.startsWith('@/')) return resolve(root, 'apps/viewer/src', specifier.slice(2));
  if (!specifier.startsWith('.')) return null;
  return resolve(dirname(importer), specifier);
}

function sourceFile(path) {
  const ext = extname(path);
  const candidates = ext === '.js'
    ? [path.slice(0, -3) + '.ts', path.slice(0, -3) + '.tsx', path]
    : ext ? [path] : [path, `${path}.ts`, `${path}.tsx`, join(path, 'index.ts'), join(path, 'index.tsx')];
  return candidates.find((candidate) => existsSync(candidate) && /\.(?:[cm]?[jt]sx?)$/.test(candidate)) ?? null;
}

/** @returns {{ reachable: string[], offenders: string[] }} */
export function findStoreImportCycles(root = repoRoot) {
  const entry = resolve(root, STORE_ENTRY);
  const visited = new Set();
  const offenders = new Set();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    for (const specifier of imports(source)) {
      if (file !== entry && (specifier === '@/store' || specifier === '@/store/index')) {
        offenders.add(file);
        continue;
      }
      const target = resolveModule(specifier, file, root);
      if (!target) continue;
      const resolved = sourceFile(target);
      if (!resolved) continue;
      if (file !== entry && resolved === entry) offenders.add(file);
      else pending.push(resolved);
    }
  }
  return { reachable: [...visited].sort(), offenders: [...offenders].sort() };
}

/** @returns {{ reachable: string[], offenders: string[], newOffenders: string[], staleRows: string[] }} */
export function checkStoreImportCycles(root = repoRoot, allowed = root === repoRoot
  ? readFileSync(resolve(root, ALLOWLIST), 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  : []) {
  const result = findStoreImportCycles(root);
  const allowedPaths = new Set(allowed.map((path) => resolve(root, path)));
  const offenderPaths = new Set(result.offenders);
  return {
    ...result,
    newOffenders: result.offenders.filter((path) => !allowedPaths.has(path)),
    // A row whose module no longer imports the store must go: kept, it would let that cycle return unnoticed.
    staleRows: [...allowedPaths].filter((path) => !offenderPaths.has(path)).sort(),
  };
}

function main() {
  const { reachable, offenders, newOffenders, staleRows } = checkStoreImportCycles();
  const rel = (file) => `  ${file.slice(repoRoot.length + 1)}`;
  if (newOffenders.length) {
    console.error(`New store import cycle: reachable modules import ${STORE_ENTRY}:\n${newOffenders.map(rel).join('\n')}`);
    process.exitCode = 1;
  }
  if (staleRows.length) {
    console.error(`Stale rows in ${ALLOWLIST} (the module no longer imports ${STORE_ENTRY}); delete them:\n${staleRows.map(rel).join('\n')}`);
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) console.log(`Store import cycle check passed (${reachable.length} reachable modules; ${offenders.length} existing offender(s) allowlisted).`);
}

if (isMainEntry(import.meta.url)) main();
