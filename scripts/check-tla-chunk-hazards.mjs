/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fails the build when an emitted chunk that is NOT wrapped by
 * vite-plugin-top-level-await statically imports from one that IS.
 *
 * Why this exists (#2243 / #2246): the plugin rewrites a chunk that needs
 * transforming into an async body and assigns its exports inside a deferred
 * `__tla` promise. An importer that is not itself wrapped evaluates
 * synchronously and can read one of those bindings before it is assigned. If
 * it reads it at MODULE SCOPE the result is `TypeError: <x> is not a
 * function` during module evaluation — before any React error boundary
 * exists, so #root stays empty and the whole app white-screens. That is
 * exactly how ifclite.com went down: 24 such edges existed, one of them had a
 * module-scope consumer (Radix Tooltip calling createPopperScope), and a
 * routine chunk reshuffle moved it onto the entry's synchronous path.
 *
 * The check is deliberately on the EDGE, not on "is the binding used at
 * module scope". Whether a given edge is fatal depends on how the importer
 * happens to use the binding today, which is precisely the accident that let
 * this sit latent. An edge is the thing that is structurally wrong.
 *
 * Run after `vite build` for apps/viewer.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const assetsDir = process.argv[2] ?? 'apps/viewer/dist/assets';

if (!existsSync(assetsDir)) {
  console.error(`[tla-hazards] No such directory: ${assetsDir}`);
  console.error('[tla-hazards] Build apps/viewer first, or pass the assets dir as argv[2].');
  process.exit(2);
}

const files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
if (files.length === 0) {
  console.error(`[tla-hazards] No .js chunks in ${assetsDir} — refusing to report success.`);
  process.exit(2);
}

/** Static `from "./chunk.js"` specifiers. Dynamic import() is irrelevant here:
 *  it is awaited by construction, so it can never observe an unassigned binding. */
const STATIC_IMPORT = /from\s*"\.\/([A-Za-z0-9_.\-]+\.js)"/g;

const chunks = new Map();
for (const name of files) {
  const text = readFileSync(join(assetsDir, name), 'utf8');
  chunks.set(name, {
    wrapped: text.includes('__tla'),
    imports: new Set([...text.matchAll(STATIC_IMPORT)].map((m) => m[1])),
  });
}

const hazards = [];
for (const [name, chunk] of chunks) {
  if (chunk.wrapped) continue; // it awaits its own deps; safe by construction
  for (const target of chunk.imports) {
    if (chunks.get(target)?.wrapped) hazards.push([name, target]);
  }
}

const wrapped = [...chunks.values()].filter((c) => c.wrapped).length;
console.log(`[tla-hazards] ${chunks.size} chunks, ${wrapped} __tla-wrapped, ${hazards.length} hazard edges`);

if (hazards.length > 0) {
  console.error('');
  console.error('[tla-hazards] FAIL — an unwrapped chunk statically imports a __tla-wrapped chunk.');
  console.error('[tla-hazards] Any module-scope read of such a binding throws before React mounts (#2243).');
  console.error('');
  for (const [from, to] of hazards) console.error(`    ${from}  ->  ${to}`);
  console.error('');
  console.error('[tla-hazards] Usual cause: vite-plugin-top-level-await did not propagate the wrap to');
  console.error('[tla-hazards] this importer. See patches/vite-plugin-top-level-await@1.6.0.patch and #2246.');
  process.exit(1);
}

console.log('[tla-hazards] OK — every importer of a deferred chunk is itself deferred.');
