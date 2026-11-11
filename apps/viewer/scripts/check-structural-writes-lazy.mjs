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

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from '../../../scripts/lib/is-main-entry.mjs';
import { checkLazyOnly } from './startup-chunks.mjs';

/** Text only the structural write path carries, at least one string per
 *  exported `@ifc-lite/create` structural builder (the bundler drops unused
 *  exports, so a shared module is no cover) and the SDK factory's schema
 *  refusal. Mostly error-message prefixes or the builder name each action
 *  passes to its refusal; the two connect builders have neither,
 *  so their `addEntity` call is matched as the minifier writes it. If its
 *  quoting changes, the "proves nothing" check fails rather than passing. The
 *  read side (`extractStructuralOnDemand`, the properties card) has none. */
export const STRUCTURAL_WRITE_SIGNATURES = [
  'addStructuralAnalysisModelToStore:',
  'addStructuralCurveMemberToStore:',
  'addStructuralPointConnectionToStore:',
  'addStructuralLoadGroupToStore:',
  'assignToStructuralGroupInStore:',
  'addStructuralPointActionToStore',
  'addStructuralLinearActionToStore',
  'addEntity(`IfcRelConnectsStructuralMember`',
  'addEntity(`IfcRelConnectsStructuralActivity`',
  'bim.store structural authoring:',
];

const REMEDY = 'Keep the structural write path behind src/sdk/adapters/store-adapter-structural.ts (loadStructuralWrites): '
  + 'find the static import that pulls createStructuralStoreBackend or an @ifc-lite/create structural builder into the startup graph.';

export function checkStructuralWritesLazy(directory) {
  // One group per signature: each builder must be found, not just one of them.
  const groups = STRUCTURAL_WRITE_SIGNATURES.map((signature) => ({ name: signature, signatures: [signature] }));
  return checkLazyOnly(directory, groups, REMEDY, 'Was a structural builder removed, or did its error message change?');
}

if (isMainEntry(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
  const { eager, lazy } = await checkStructuralWritesLazy(directory);
  console.log(`structural writes lazy: ${eager.length} startup chunks free of structural write code; lazy chunks carrying it: ${lazy.join(', ')}`);
}
