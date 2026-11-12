/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place a load may start work before its interface reset ("work starts
 * at the pick"). `loadFile` calls {@link runPickStart} once, after it has
 * claimed its session and before `resetViewerState`, so work handed to another
 * thread here overlaps the reset and the viewer-shell mount instead of waiting
 * for them.
 *
 * Two kinds of registrant:
 * - starters run synchronously, in registration order, and must not block
 *   (they post to a worker and return). A throwing starter is logged and the
 *   others still run.
 * - at most one yield, for work that needs one turn of the event loop before
 *   the reset. It is awaited for at most `capMs`; a yield that never settles
 *   costs the load `capMs`, never more.
 *
 * With no yield registered, `runPickStart` returns `undefined` and the load
 * does not await at all, so the reset runs in the same task as the pick.
 */

import type { LoadTarget } from '../useIfcLoader.js';
import type { GeometryKernelLoad } from './geometryEventSource.js';

export interface PickStartContext {
  file: File;
  target: LoadTarget;
  kernel: GeometryKernelLoad;
  /** A resource retry or another re-run of the same file, not the user's pick. */
  retry: boolean;
  /** False once a newer load superseded this one. */
  isCurrent(): boolean;
}

export type PickStarter = (ctx: PickStartContext) => void;
export type PickYield = (ctx: PickStartContext) => Promise<unknown> | void;

/** Upper bound for the one yield before the reset. */
export const PICK_YIELD_CAP_MS = 50;

const starters: PickStarter[] = [];
let pickYield: PickYield | null = null;

/** Add a synchronous starter. Returns its unregister function. */
export function registerPickStarter(starter: PickStarter): () => void {
  starters.push(starter);
  return () => {
    const i = starters.indexOf(starter);
    if (i >= 0) starters.splice(i, 1);
  };
}

/** Set the single yield before the reset. A second registration while one is set throws. */
export function registerPickYield(fn: PickYield): () => void {
  if (pickYield) throw new Error('registerPickYield: a pick yield is already registered');
  pickYield = fn;
  return () => {
    if (pickYield === fn) pickYield = null;
  };
}

/**
 * Run the starters, then the yield. Returns a promise only when a yield exists
 * and returned one; it settles when that promise settles or after `capMs`,
 * whichever is first, and never rejects.
 */
export function runPickStart(ctx: PickStartContext, capMs = PICK_YIELD_CAP_MS): Promise<void> | undefined {
  for (const starter of [...starters]) {
    try {
      starter(ctx);
    } catch (err) {
      console.warn('[pickStart] starter failed:', err);
    }
  }
  if (!pickYield) return undefined;
  let pending: Promise<unknown> | void;
  try {
    pending = pickYield(ctx);
  } catch (err) {
    console.warn('[pickStart] yield failed:', err);
    return undefined;
  }
  if (!pending) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => { timer = setTimeout(resolve, capMs); });
  return Promise.race([pending.then(() => undefined, (err: unknown) => { console.warn('[pickStart] yield rejected:', err); }), cap])
    .finally(() => clearTimeout(timer));
}
