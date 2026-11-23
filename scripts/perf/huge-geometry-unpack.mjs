#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rebuild files a remote GPU job printed with `huge-geometry-cinema.mjs --emit-stdout`
 * (`HGFILE <rel> <part>/<parts> <base64>` lines, e.g. from an `ifc-fleet run --gpu` log on the PC):
 *
 *   node scripts/perf/huge-geometry-unpack.mjs LOG OUT_DIR
 *
 * Only complete files are written; a file with missing parts is reported and skipped.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isMainEntry } from '../lib/is-main-entry.mjs';

/** Parse HGFILE lines from `text`; returns { files: Map(rel -> Buffer), incomplete: [rel] }. */
export function unpack(text) {
  const parts = new Map();
  for (const line of text.split('\n')) {
    const m = /^HGFILE (\S+) (\d+)\/(\d+) (\S*)$/.exec(line.trim());
    if (!m) continue;
    const [, rel, i, n, b64] = m;
    if (!parts.has(rel)) parts.set(rel, { n: Number(n), chunks: new Map() });
    parts.get(rel).chunks.set(Number(i), b64);
  }
  const files = new Map(), incomplete = [];
  for (const [rel, { n, chunks }] of parts) {
    if (chunks.size !== n) { incomplete.push(rel); continue; }
    files.set(rel, Buffer.from(Array.from({ length: n }, (_, k) => chunks.get(k + 1)).join(''), 'base64'));
  }
  return { files, incomplete };
}

if (isMainEntry(import.meta.url)) {
  const [log, out] = process.argv.slice(2);
  if (!log || !out) { console.error('usage: huge-geometry-unpack.mjs LOG OUT_DIR'); process.exit(2); }
  const { files, incomplete } = unpack(readFileSync(log, 'utf8'));
  for (const [rel, buf] of files) {
    const dest = resolve(out, rel);
    const inside = relative(resolve(out), dest);
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) { console.error(`skip unsafe path ${rel}`); continue; }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    console.log(`${dest} ${buf.length} bytes`);
  }
  for (const rel of incomplete) console.error(`incomplete: ${rel}`);
  process.exit(incomplete.length ? 1 : 0);
}
