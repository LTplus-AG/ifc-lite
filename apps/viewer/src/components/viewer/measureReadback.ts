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
type Gate = typeof import('./measureReadbackGate.js');
let gate: Promise<Gate> | undefined;
let acting = false;
let importGate: () => Promise<Gate> = () => import('./measureReadbackGate.js');
/** TEST ONLY: replace how the gate chunk loads (e.g. one that fails); `null` restores it and forgets the loaded one. */
export function setMeasureReadbackGateLoaderForTest(loader: (() => Promise<Gate>) | null): void {
  importGate = loader ?? (() => import('./measureReadbackGate.js'));
  gate = undefined;
}

/**
 * The gate chunk, loaded once. A failed load is forgotten, so the next measure action retries it instead of
 * every later action awaiting the same rejected import (measuring would otherwise stop until a reload).
 */
function loadGate(): Promise<Gate> {
  gate ??= importGate().catch((error: unknown) => { gate = undefined; throw error; });
  return gate;
}

/**
 * A released scene routes `act` through the gate and returns true; a resident one (or the gate acting on a
 * read it finished) returns false: act now. The scope a placement is dropped by is captured here, now.
 */
export function viaReadback(ctx: MouseHandlerContext, kind: ReadbackKind, act: () => void, x = 0, y = 0): boolean {
  const scene = ctx.renderer.getScene() as { isGeometryDataReleased?: () => boolean };
  if (acting || scene.isGeometryDataReleased?.() !== true) return false;
  // A placement's (x, y) names a surface only under the view and the visibility it was clicked in: keep both.
  const place = kind === 'place';
  const scope = { tool: ctx.activeToolRef.current, gesture: useViewerStore.getState().measureGestureEpoch,
    view: place ? viewOf(ctx) : undefined, shown: place ? shownOf(ctx) : undefined };
  // A gate that fails to load acts on nothing (a released scene cannot raycast without its readback) and says so.
  void loadGate().then(
    (loaded) => loaded.route(ctx, kind, act, x, y, scope, actNow, useViewerStore.getState, () => viewOf(ctx), () => shownOf(ctx)),
    (error: unknown) => console.error('[Measure] Geometry readback did not load; the action was not run', error),
  );
  return true;
}

/**
 * What a pixel names a surface under: the view-projection matrix (a copy) plus the renderer's pick-geometry
 * revision, which a renderer-side model move (setModelTranslation/Rotation) bumps with no store change.
 * Undefined when the renderer has no camera to ask.
 */
export function viewOf(ctx: MouseHandlerContext): readonly number[] | undefined {
  const renderer = ctx.renderer as {
    getCamera?: () => { getViewProjMatrix?: () => { m: ArrayLike<number> } };
    getPickGeometryRevision?: () => number;
  };
  const m = renderer.getCamera?.()?.getViewProjMatrix?.().m;
  if (!m) return undefined;
  const view = Array.from(m);
  const revision = renderer.getPickGeometryRevision?.();
  return revision === undefined ? view : [...view, revision];
}

/**
 * The hide and isolate sets a pick is made under. The store replaces these sets on every change, so their
 * identities say whether what is shown at a pixel can have changed.
 */
export function shownOf(ctx: MouseHandlerContext): readonly [unknown, unknown] {
  return [ctx.hiddenEntitiesRef.current, ctx.isolatedEntitiesRef.current];
}

/** The gate acting on a finished read: a handler re-entered from here runs its resident path. */
export function actNow(act: () => void): void {
  acting = true;
  try { act(); } finally { acting = false; }
}

/** A press, release or preview cancel. Nothing is pending unless the gate was ever loaded. */
export function cancelMeasureReadbacks(): void {
  // A gate that failed to load has nothing pending.
  void gate?.then((loaded) => loaded.invalidatePendingMeasureReadbacks(), () => undefined);
}
