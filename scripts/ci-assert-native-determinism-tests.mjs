/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { resolve } from 'node:path';
import { main as assertCargoTargets } from './ci-assert-runnable-cargo-tests.mjs';

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

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
