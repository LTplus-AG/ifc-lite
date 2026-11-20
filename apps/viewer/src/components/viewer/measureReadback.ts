/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The eager half of measure readback (#10264, #10880), kept minimal: the entry
 * chunk carries only this. A resident scene answers at once and loads nothing;
 * a released one loads `measureReadbackGate`, which owns every read and its
 * lifetimes. Every call `.then`s the same import, so calls (cancels included)
 * still run in the order they were made.
 */

import { useViewerStore } from '@/store';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';

export type ReadbackKind = 'hover' | 'drag' | 'place' | 'finish';
let gate: Promise<typeof import('./measureReadbackGate.js')> | undefined;
let acting = false;

/**
 * A released scene routes `act` through the gate and returns true; a resident one (or the gate acting on a
 * read it finished) returns false: act now. The scope a placement is dropped by is captured here, now.
 */
export function viaReadback(ctx: MouseHandlerContext, kind: ReadbackKind, act: () => void, x = 0, y = 0): boolean {
  const scene = ctx.renderer.getScene() as { isGeometryDataReleased?: () => boolean };
  if (acting || scene.isGeometryDataReleased?.() !== true) return false;
  // A placement's (x, y) names a surface only under the view it was clicked in: keep that view.
  const view = kind === 'place' ? viewOf(ctx) : undefined;
  const scope = { tool: ctx.activeToolRef.current, gesture: useViewerStore.getState().measureGestureEpoch, view };
  void (gate ??= import('./measureReadbackGate.js')).then((loaded) => loaded.route(ctx, kind, act, x, y, scope, actNow, useViewerStore.getState, () => viewOf(ctx)));
  return true;
}

/** The current view-projection matrix (a copy), or undefined when the renderer has no camera to ask. */
export function viewOf(ctx: MouseHandlerContext): readonly number[] | undefined {
  const camera = (ctx.renderer as { getCamera?: () => { getViewProjMatrix?: () => { m: ArrayLike<number> } } }).getCamera?.();
  const m = camera?.getViewProjMatrix?.().m;
  return m ? Array.from(m) : undefined;
}

/** The gate acting on a finished read: a handler re-entered from here runs its resident path. */
export function actNow(act: () => void): void {
  acting = true;
  try { act(); } finally { acting = false; }
}

/** A press, release or preview cancel. Nothing is pending unless the gate was ever loaded. */
export function cancelMeasureReadbacks(): void {
  void gate?.then((loaded) => loaded.invalidatePendingMeasureReadbacks());
}
