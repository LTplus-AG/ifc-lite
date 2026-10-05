/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared by the xmatch test files whose subjects import built `@ifc-lite/*`
 * packages (`guards.mjs`, `mutate-support.mjs` and `merge-base-split.mjs` read
 * `packages/{parser,encoding}/dist`, `successor-mutations.mjs` reads
 * `packages/diff/dist`). Without that build output a static import fails the
 * whole file before any test registers, which reads as a failure of the code
 * under test rather than a missing `pnpm build`. CI restores the build output
 * first, and `skipUnlessBuilt` never skips there.
 *
 * A test file imports `{ test, load }` from here instead of `node:test` and
 * `await load('./subject.mjs')` instead of a static import: with the build
 * output missing, `load` returns an empty namespace and every `test` is
 * registered as skipped with the reason.
 */

import { test as nodeTest } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skipUnlessBuilt } from '../lib/host-preconditions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SKIP_UNBUILT = skipUnlessBuilt(
  ROOT,
  ['packages/parser/dist/index.js', 'packages/encoding/dist/index.js', 'packages/diff/dist/class-families.js'],
  'pnpm build',
);

/** `node:test`'s `test`, skipped with the reason when the build output is missing. */
export function test(name, optionsOrFn, maybeFn) {
  const fn = maybeFn ?? optionsOrFn;
  const options = maybeFn ? optionsOrFn : {};
  return nodeTest(name, { ...options, skip: SKIP_UNBUILT || options.skip }, fn);
}

/** Dynamic stand-in for a static import of a module that needs the build output. */
export function load(specifier) {
  return SKIP_UNBUILT ? Promise.resolve({}) : import(specifier);
}
