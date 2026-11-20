/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Readback for measure actions over released CPU geometry (#10264). A released
 * scene answers a raycast only from pieces read back for that exact point, so a
 * drag, polyline, radius or angle point that no hover prepared reads its own
 * point back first, then acts. Resident scenes act synchronously, as before.
 *
 * - Reads run one after another, so actions land in the order they were asked.
 * - Two lifetimes. A preview (hover, drag) is fenced by `invalidatePendingMeasureReadbacks`
 *   (any press, release or cancel of the preview frame). A placement (a polyline, radius or angle
 *   point) is a user action: a later press never drops it; only its own `stillValid` (a gesture
 *   reset: Esc, a mode or tool switch, a model reposition) does.
 * - An action runs only on `fed` or `no-hit`. A `cancelled` read (a newer read
 *   took the feeder) is retried (a placement up to 8 times); an `unavailable` one (an unbacked front
 *   surface, an instanced occurrence) never acts: a raycast past it could
 *   measure or snap to whatever is behind, a point cloud included.
 * - A read answers the hide/isolate state it was made under. If that state changed before the
 *   action runs (a surface unhidden mid-read), the read is redone first, like a `cancelled` one:
 *   the raycast would otherwise test the now-visible surface against pieces chosen without it.
 */

import type { Renderer } from '@ifc-lite/renderer';
import { sceneGeometryReleased } from '@/lib/geometry-backing/scene-released';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import type { ReadbackKind } from './measureReadback.js';

type Visibility = { hiddenIds?: ReadonlySet<number>; isolatedIds?: ReadonlySet<number> | null };
/** The hide/isolate state now: a fixed value, or the handler's refs read at each step. */
type VisibilityNow = Visibility | (() => Visibility);
const visibilityOf = (v: VisibilityNow): (() => Visibility) => (typeof v === 'function' ? v : () => v);
/** The store replaces these sets on every change, so identity tells whether a read still answers. */
const sameVisibility = (a: Visibility, b: Visibility): boolean => a.hiddenIds === b.hiddenIds && (a.isolatedIds ?? null) === (b.isolatedIds ?? null);
type Feed = (renderer: Renderer, x: number, y: number, visibility: Visibility) => Promise<string>;
const realFeed: Feed = async (...args) => (await import('@/lib/geometry-backing/readback-measure')).feedReadbackAt(...args);
let feed: Feed = realFeed;
/** TEST ONLY: drive the gate's read step; `null` restores the real feeder. */
export function setMeasureReadbackFeedForTest(next: Feed | null): void { feed = next ?? realFeed; }

const PLACEMENT_RETRIES = 8;
let epoch = 0;
let chain: Promise<void> = Promise.resolve();
/** The newest hover read: an older one that resolves later, or one a press cancelled, never acts. */
let hoverRead = 0;

/** A press, release or preview cancel: no PREVIEW queued or in flight before it may act, hover included. */
export function invalidatePendingMeasureReadbacks(): void { epoch++; hoverRead++; }

/** Whether a read outcome may be acted on as a real answer for that point. */
export const answered = (outcome: string): boolean => outcome === 'fed' || outcome === 'no-hit' || outcome === 'resident';

/** Run `action` now (resident), or after reading (x, y) back. Returns true if deferred. */
export function runWithReadback(renderer: Renderer, x: number, y: number, visibility: VisibilityNow, action: () => void,
  stillValid: () => boolean = () => true, kind: 'preview' | 'placement' = 'preview'): boolean {
  if (!sceneGeometryReleased(renderer)) { action(); return false; }
  const mine = epoch;
  const valid = () => (kind === 'placement' || mine === epoch) && stillValid();
  const now = visibilityOf(visibility);
  chain = chain.then(async () => {
    if (!valid()) return;
    // A newer read (a moving hover) took the feeder, or the hide/isolate state changed under it: read again.
    // A preview retries once; a placement keeps retrying while it is valid (bounded), so a click is never
    // dropped because the pointer kept moving.
    let under = now();
    let outcome = await feed(renderer, x, y, under);
    const stale = () => outcome === 'cancelled' || !sameVisibility(under, now());
    for (let tries = kind === 'placement' ? PLACEMENT_RETRIES : 1; stale() && valid() && tries > 0; tries--) {
      under = now();
      outcome = await feed(renderer, x, y, under);
    }
    if (stale() && kind === 'placement' && valid()) console.warn('[Measure] Point not placed: geometry readback kept being superseded');
    if (valid() && !stale() && answered(outcome)) action();
  }).catch((error: unknown) => console.error('[Measure] Geometry readback failed', error));
  return true;
}

/**
 * A hover preview: `run` now (resident), else after its own read, latest wins. It acts only on an answered
 * read; an `unavailable` one (never raycast past an unbacked front: it could snap to a point cloud behind)
 * clears the preview via `clear`. A `cancelled` one was superseded by a newer read, which acts instead.
 */
export function hoverWithReadback(renderer: Renderer, x: number, y: number, visibility: VisibilityNow, run: () => void,
  stillValid: () => boolean, clear: () => void): void {
  if (!sceneGeometryReleased(renderer)) { run(); return; }
  const mine = ++hoverRead;
  const now = visibilityOf(visibility);
  const under = now();
  void feed(renderer, x, y, under).then((outcome) => {
    // A hide/isolate change mid-read: this preview answers the old state, and the next hover reads the new one.
    if (mine !== hoverRead || !stillValid() || !sameVisibility(under, now())) return;
    if (answered(outcome)) run(); else if (outcome === 'unavailable') clear();
  }, (error: unknown) => console.error('[Measure] Geometry readback failed', error));
}

/**
 * Run `action` after every placement already queued (resident: now), still fenced by `stillValid`. A
 * double-click finish must see the points of the clicks before it, which a released scene places later.
 */
export function afterPlacements(renderer: Renderer, action: () => void, stillValid: () => boolean): void {
  if (!sceneGeometryReleased(renderer)) { action(); return; }
  chain = chain.then(() => { if (stillValid()) action(); }).catch((error: unknown) => console.error('[Measure] Finish failed', error));
}

/** Settles once every queued read has run (tests). */
export function measureReadbacksIdle(): Promise<void> { return chain; }

// The handlers' readback paths, loaded only for a released scene (`measureReadback.ts` is the eager half).

/**
 * What a click captured when it happened: the reset that drops its placement is any change of these. `view`
 * (a placement's view-projection matrix at the click): its (x, y) names a surface only under that view, so a
 * placement whose view changed before its read ran (an orbit, pan or zoom) is dropped, never placed on
 * whatever is now under those pixels.
 */
export interface PlacementScope { tool: string; gesture: number; view?: readonly number[] }

/** Whether `now` is the view `then` was captured in (no capture: nothing to compare, treated as unchanged). */
export function sameView(then: readonly number[] | undefined, now: readonly number[] | undefined): boolean {
  if (!then || !now) return true;
  return then.length === now.length && then.every((v, i) => v === now[i]);
}

/** One entry for every handler: a hover or drag preview, a placement, or a double-click finish. */
/** The store state the readback paths read, handed in by the eager half. */
export type GateStore = () => { measureGestureEpoch: number; setMeasurePointLive: (point: null) => void };

// `actNow`, `viewNow` and the store come from the eager half, never by static import: that cycle would merge
// this module into the entry chunk, and a store import lists its whole graph as this chunk's preload dependencies.
export function route(ctx: MouseHandlerContext, kind: ReadbackKind, act: () => void, x: number, y: number, scope: PlacementScope,
  actNow: (act: () => void) => void, store: GateStore, viewNow: () => readonly number[] | undefined = () => undefined): void {
  const visibility = (): Visibility => ({ hiddenIds: ctx.hiddenEntitiesRef.current, isolatedIds: ctx.isolatedEntitiesRef.current });
  const measuring = () => ctx.activeToolRef.current === 'measure';
  const inScope = () => ctx.activeToolRef.current === scope.tool && store().measureGestureEpoch === scope.gesture;
  if (kind === 'hover') {
    // A refused hover (unavailable) leaves no preview residue.
    hoverWithReadback(ctx.renderer, x, y, visibility, () => actNow(act), measuring, () => {
      ctx.setSnapTarget(null); ctx.setSnapVisualization(null); ctx.clearEdgeLock(); store().setMeasurePointLive(null);
    });
  } else if (kind === 'drag') runWithReadback(ctx.renderer, x, y, visibility, () => actNow(act), measuring);
  else if (kind === 'place') {
    let warned = false;
    const placeable = () => {
      if (!inScope()) return false;
      if (sameView(scope.view, viewNow())) return true;
      if (!warned) { warned = true; console.warn('[Measure] Point not placed: the view moved before its geometry was read back'); }
      return false;
    };
    runWithReadback(ctx.renderer, x, y, visibility, () => actNow(act), placeable, 'placement');
  }
  // A double-click finish runs after every placement already queued in its gesture.
  else afterPlacements(ctx.renderer, () => actNow(act), () => scope.tool === 'measure' && inScope());
}
