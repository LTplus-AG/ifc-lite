#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Guard: the structural write path (the `@ifc-lite/create` structural builders
 * and the SDK's `createStructuralStoreBackend`) loads in its own chunk, never
 * at viewer startup (#9668). It runs only when a script or the assistant
 * authors structural entities, and each new builder would otherwise grow the
 * boot bundle that `bundle/viewer-eager-js-bytes` gates.
 *
 * No file in the startup graph may carry structural write code, and some other
 * chunk must, or the check would pass vacuously. Runs at the tail of the
 * viewer's `build` script, like check-rhino3dm-lazy.
 */

import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from '../../../scripts/lib/is-main-entry.mjs';
import { lazyChunks, startupChunks } from './startup-chunks.mjs';

/** Error-message prefixes only the structural write path carries: four
 *  `@ifc-lite/create` builders and the SDK factory's schema refusal. The
 *  read side (`extractStructuralOnDemand`, the properties card) has none. */
export const STRUCTURAL_WRITE_SIGNATURES = [
  'addStructuralCurveMemberToStore:',
  'addStructuralPointConnectionToStore:',
  'addStructuralLoadGroupToStore:',
  'assignToStructuralGroupInStore:',
  'bim.store structural authoring:',
];

const REMEDY = 'Keep the structural write path behind src/sdk/adapters/store-adapter-structural.ts (loadStructuralWrites): '
  + 'find the static import that pulls createStructuralStoreBackend or an @ifc-lite/create structural builder into the startup graph.';

export async function checkStructuralWritesLazy(directory) {
  const eager = await startupChunks(directory);
  for (const [file, code] of eager) {
    for (const signature of STRUCTURAL_WRITE_SIGNATURES) {
      if (code.includes(signature)) throw new Error(`Startup chunk ${relative(directory, file)} contains ${signature}. ${REMEDY}`);
    }
  }
  const lazy = [];
  const found = new Set();
  for (const [file, code] of await lazyChunks(directory, eager)) {
    const hits = STRUCTURAL_WRITE_SIGNATURES.filter((signature) => code.includes(signature));
    for (const signature of hits) found.add(signature);
    if (hits.length) lazy.push(relative(directory, file));
  }
  const missing = STRUCTURAL_WRITE_SIGNATURES.filter((signature) => !found.has(signature));
  if (missing.length) {
    throw new Error(`No chunk in ${directory} carries ${missing.join(', ')}, so this check proves nothing. `
      + 'Was a structural builder removed, or did its error message change?');
  }
  return { eager: [...eager.keys()].map((file) => relative(directory, file)).sort(), lazy: lazy.sort() };
}

if (isMainEntry(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
  const { eager, lazy } = await checkStructuralWritesLazy(directory);
  console.log(`structural writes lazy: ${eager.length} startup chunks free of structural write code; lazy chunks carrying it: ${lazy.join(', ')}`);
}
