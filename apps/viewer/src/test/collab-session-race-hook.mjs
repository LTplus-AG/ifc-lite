/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-only loader hook for `collabSlice.leave-during-join-race.test.ts`.
 *
 * Registered via `node:module`'s `register()` from inside that one test
 * file, so it only affects that file's (isolated, per-file) process — it
 * does not touch the shared `vite-module-hooks` pipeline other suites rely
 * on, and it does not change what `@ifc-lite/collab` exports for anything
 * else.
 *
 * Wraps `createCollabSession` so the test can pause the REAL session's
 * `whenSynced` at a chosen point (after the real IndexedDB/CRDT bring-up
 * has actually happened) and resume it on demand — the deterministic
 * substitute for "the network happened to take a while". Every other
 * export passes through untouched.
 */

const MARKER = 'collab-session-race-hook:';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@ifc-lite/collab') {
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
import { createCollabSession as __realCreateCollabSession } from ${JSON.stringify(realUrl)};
export async function createCollabSession(opts) {
  const session = await __realCreateCollabSession(opts);
  const gate = globalThis.__collabSyncGate;
  if (gate) {
    const original = session.whenSynced;
    // A LAZY getter, not an eager reassignment: firing the "gated" signal at
    // session-creation time would race the caller's own \`await
    // collab.createCollabSession(...)\` continuation (both settle in the same
    // tick, and microtask order between two unrelated promise chains is not
    // something a test should depend on). A getter fires exactly when
    // \`startCollab\` evaluates \`await session.whenSynced\` — which can only
    // happen AFTER its own preceding \`get().collabRoomId !== roomId\` guard
    // already ran, in the same synchronous stretch of code. That ordering is
    // structural (their statement order), not a timing accident.
    let read = false;
    Object.defineProperty(session, 'whenSynced', {
      configurable: true,
      enumerable: true,
      get() {
        if (!read) {
          read = true;
          globalThis.__collabSessionGated?.();
        }
        return original.then(() => gate);
      },
    });
  }
  return session;
}
`;
    return { source, format: 'module', shortCircuit: true };
  }
  return nextLoad(url, context);
}
