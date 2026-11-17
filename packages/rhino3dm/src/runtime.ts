/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type factory from 'rhino3dm';
import type { Write3dmOptions } from './types.js';
export type Rhino = Awaited<ReturnType<typeof factory>>;
let runtime: Promise<Rhino> | undefined;
/** The module `loadRhino` hands out now; undefined until one has loaded, and again once it is discarded. */
let current: Rhino | undefined;
export function loadRhino(locateFile?: Write3dmOptions['locateFile']): Promise<Rhino> {
  return runtime ??= import('#rhino-factory')
    .then(({ default: init }) => init({ locateFile }))
    .then(rhino => { current = rhino; return rhino; })
    .catch(error => { runtime = undefined; throw error; });
}
/**
 * Whether this module is the one still in use. A caller that awaited the runtime
 * holds its own reference, so after a discard it can be holding a dead module.
 * Not exported: checking and then awaiting again is the shape that stranded a
 * caller on a dead module, so `withCurrentRhino` is the only way to the module.
 */
function isCurrentRhino(rhino: Rhino): boolean { return rhino === current; }
/**
 * Run `work` on the module that is current, reacquiring the runtime until it is. One recheck after
 * the load is not enough, because the reacquire is itself an await: another caller's abort during
 * it hands this caller a module that is already discarded. `work` is called in the same
 * synchronous step as the check, so nothing can discard the module in between; it holds the
 * parse or the write, which need no await of their own. Each extra pass costs another caller an
 * abort, so the loop only goes round while modules really are being discarded.
 */
export async function withCurrentRhino<T>(locateFile: Write3dmOptions['locateFile'] | undefined, work: (rhino: Rhino) => T): Promise<T> {
  for (;;) {
    const rhino = await loadRhino(locateFile);
    if (isCurrentRhino(rhino)) return work(rhino);
  }
}
/** Drop the shared runtime after an emscripten abort, which leaves the module unusable. */
export function discardRhino(): void { runtime = undefined; current = undefined; }
// Upstream's .d.ts omits Embind ClassHandle.delete(). Use on owned wrappers,
// including by-value table/settings/mesh-list wrappers (release before their owner).
export function dispose(value: unknown): void {
  if (value == null) return;
  // File3dmStringTable shadows delete() with delete(key). Call the root
  // ClassHandle destructor (the prototype just below Object.prototype) so
  // cleanup never invokes a table mutation, whatever the class depth.
  let base = Object.getPrototypeOf(value) as object;
  while (Object.getPrototypeOf(base) !== Object.prototype) base = Object.getPrototypeOf(base) as object;
  (base as { delete(this: unknown): void }).delete.call(value);
}
