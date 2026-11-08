/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type factory from 'rhino3dm';
import type { Write3dmOptions } from './types.js';
type Rhino = Awaited<ReturnType<typeof factory>>;
let runtime: Promise<Rhino> | undefined;
export function loadRhino(locateFile?: Write3dmOptions['locateFile']): Promise<Rhino> {
  return runtime ??= import('#rhino-factory')
    .then(({ default: init }) => init({ locateFile }))
    .catch(error => { runtime = undefined; throw error; });
}
// Upstream's .d.ts omits Embind ClassHandle.delete(). Use on owned wrappers,
// including by-value table/settings/mesh-list wrappers (release before their owner).
export function dispose(value: unknown): void {
  if (value == null) return;
  // File3dmStringTable shadows delete() with delete(key). Call the base
  // ClassHandle destructor so cleanup never invokes a table mutation instead.
  const base = Object.getPrototypeOf(Object.getPrototypeOf(value)) as { delete(this: unknown): void };
  base.delete.call(value);
}
