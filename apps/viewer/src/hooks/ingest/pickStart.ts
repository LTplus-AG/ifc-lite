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
 * Starters run synchronously, in registration order, and must not block (they
 * post to a worker and return). A throwing starter is logged and the others
 * still run. Nothing here awaits, so the reset runs in the same task as the pick.
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

const starters: PickStarter[] = [];

/** Add a synchronous starter. Returns its unregister function. */
export function registerPickStarter(starter: PickStarter): () => void {
  starters.push(starter);
  return () => {
    const i = starters.indexOf(starter);
    if (i >= 0) starters.splice(i, 1);
  };
}

/** Run every starter, in registration order. */
export function runPickStart(ctx: PickStartContext): void {
  for (const starter of [...starters]) {
    try {
      starter(ctx);
    } catch (err) {
      console.warn('[pickStart] starter failed:', err);
    }
  }
}
