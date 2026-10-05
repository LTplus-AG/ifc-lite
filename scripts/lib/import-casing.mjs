/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure resolver behind scripts/check-import-casing.mjs.
 */

import { posix } from 'node:path';

const SOURCE_RE = /\.(?:[cm]?[jt]sx?)$/;
const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
// `./x.js` in TypeScript source names `./x.ts` (NodeNext style).
const JS_TO_TS = { '.js': ['.ts', '.tsx', '.d.ts'], '.mjs': ['.mts', '.d.mts'], '.cjs': ['.cts', '.d.cts'], '.jsx': ['.tsx'] };

// from/export-from, bare side-effect import, dynamic import(), require(), and
// the module-path argument of vi.mock / vi.importActual-style calls.
const SPEC_RES = [
  /\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])(\.{1,2}\/[^'"\n]*|\.{1,2})\1/g,
  /\bimport\s*(['"])(\.{1,2}\/[^'"\n]*)\1/g,
  /\b(?:import|require|mock|doMock|importActual|importMock)\s*\(\s*(['"])(\.{1,2}\/[^'"\n]*|\.{1,2})\1/g,
];

export function extractRelativeSpecifiers(text) {
  const out = new Set();
  for (const re of SPEC_RES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) out.add(m[2]);
  }
  return [...out];
}

function candidatesFor(resolved) {
  const out = [resolved];
  for (const e of EXTS) out.push(resolved + e);
  const ext = posix.extname(resolved);
  if (JS_TO_TS[ext]) {
    const stem = resolved.slice(0, -ext.length);
    for (const t of JS_TO_TS[ext]) out.push(stem + t);
  }
  for (const e of EXTS) out.push(`${resolved}/index${e}`);
  return out;
}

/**
 * @param {string[]} files tracked paths (posix, repo-relative)
 * @param {(path: string) => string} read file content reader
 * @returns {{file: string, specifier: string, actual: string}[]}
 */
export function findCasingMismatches(files, read) {
  const exact = new Set(files);
  const folded = new Map();
  for (const f of files) {
    const k = f.toLowerCase();
    if (!folded.has(k)) folded.set(k, []);
    folded.get(k).push(f);
  }
  const mismatches = [];
  for (const file of files) {
    if (!SOURCE_RE.test(file)) continue;
    const text = read(file);
    for (const raw of extractRelativeSpecifiers(text)) {
      // Vite suffixes (`?raw`, `?url`) are not part of the file name.
      const specifier = raw.replace(/[?#].*$/, '');
      const resolved = posix.normalize(posix.join(posix.dirname(file), specifier)).replace(/\/$/, '');
      const cands = candidatesFor(resolved);
      if (cands.some((c) => exact.has(c))) continue;
      const near = cands.flatMap((c) => folded.get(c.toLowerCase()) ?? []);
      if (near.length > 0) mismatches.push({ file, specifier, actual: near[0] });
    }
  }
  return mismatches;
}
