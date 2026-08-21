/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-only loader hook for `collabSlice.leave-after-reconstruct.test.ts`.
 *
 * Registered via `node:module`'s `register()` from inside that one test file,
 * so it only affects that file's (isolated, per-file) process — a sibling of
 * `collab-session-race-hook.mjs`, which gates a different await for a
 * different test.
 *
 * Wraps `hydrateGeometryFromRoom` so the test can park the recipient's
 * reconstruct at the ONE await that sits after the `room:<id>` model has been
 * registered and before `startCollab`'s abandoned-join guard. That is the
 * window #3016 is about, and it is not reachable from the outside any other
 * way: every earlier await is followed by a `collabRoomId` re-check that makes
 * reconstruct return before the model exists.
 *
 * Every other export passes through untouched.
 */

const MARKER = 'collab-hydrate-gate-hook:';
const TARGET = '@/lib/collab/geometry-sync';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === TARGET) {
    const real = await nextResolve(specifier, context);
    return { url: MARKER + real.url, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(MARKER)) {
    const realUrl = url.slice(MARKER.length);
    const source = `
export * from ${JSON.stringify(realUrl)};
import { hydrateGeometryFromRoom as __realHydrate } from ${JSON.stringify(realUrl)};
export async function hydrateGeometryFromRoom(...args) {
  const gates = globalThis.__collabHydrateGates;
  if (gates) {
    // Gates are per CALL, so a test can park two overlapping joins separately
    // and release them in an order it chooses. The counter lives on globalThis
    // so a test can reset it between cases.
    const index = globalThis.__collabHydrateCalls ?? 0;
    globalThis.__collabHydrateCalls = index + 1;
    // Signal first, then park: the caller is provably suspended here once the
    // test's own await on that signal resolves.
    globalThis.__collabHydrateGated?.(index);
    if (gates[index]) await gates[index];
  }
  return __realHydrate(...args);
}
`;
    return { source, format: 'module', shortCircuit: true };
  }
  return nextLoad(url, context);
}
