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

/**
 * Match on the RESOLVED URL, not only the bare specifier — the same trap
 * `collab-session-race-hook.mjs` documents, and for the same reason.
 *
 * `module.registerHooks` (synchronous, in-thread) landed in Node 22.15.0 and
 * tsx feature-detects it. On a newer 22 the `@/…` alias is resolved to a
 * `file://` URL by that sync path BEFORE this async `register()` hook is
 * consulted, so `specifier === TARGET` never matches, nothing is wrapped,
 * `__collabHydrateGated` never fires, and the test waits forever.
 *
 * That is exactly why the specifier-only match passed on a developer machine
 * on 22.13.1 and hung on CI, whose workflow pins `node-version: 22` and so
 * floats to the newest 22.x. Verified by running this file on both: 22.13.1
 * passes, 22.23.2 times out at 60s with `testTimeoutFailure`.
 *
 * The specifier arm is kept for the older, async-only loader path, where the
 * alias reaches this hook unresolved.
 *
 * The `parentURL` guard is load-bearing rather than defensive: the wrapper
 * module below imports the REAL url, so URL-matching without it would wrap the
 * wrapper, forever.
 */
const GEOMETRY_SYNC_ENTRY = /\/lib\/collab\/geometry-sync\.tsx?$/;

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(MARKER)) return nextResolve(specifier, context);
  const real = await nextResolve(specifier, context);
  if (specifier === TARGET || GEOMETRY_SYNC_ENTRY.test(real.url.split('?')[0])) {
    return { url: MARKER + real.url, shortCircuit: true, format: 'module' };
  }
  return real;
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
