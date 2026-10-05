/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { main as assertCargoTargets } from './ci-assert-runnable-cargo-tests.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

export function main(root = process.cwd()) {
  assertCargoTargets([
    '--package', 'ifc-lite-geometry',
    '--test', 'exact_predicate_determinism',
    '--test', 'geometry_correctness_harness',
  ], root);
  assertCargoTargets([
    '--package', 'ifc-lite-processing',
    '--test', 'mesh_determinism',
  ], root);
}

if (isMainEntry(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
