/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * On-demand readback for measure entry points that have no hover in front of
 * them (a touch tap, a click after the view moved, a drag, a second click) on a
 * scene whose CPU geometry was released (#10264). The renderer answers readback
 * pieces only for the exact ray they were prepared for, so an uncovered entry
 * point prepares readback at its own coordinates and re-runs once it is ready.
 * Resident scenes run synchronously, exactly as before.
 *
 * - Coverage also requires the pieces to have been prepared under the current
 *   hide/isolate state: hiding or unhiding a surface needs a new read.
 * - Gated reads run one after another, so one gesture never cancels another's.
 *   A read a hover cancelled is retried once; an action never runs as if fed.
 * - Every deferred action is fenced: Esc/reset and leaving the tool
 *   (`invalidatePendingMeasureReadbacks`) and the caller's own `stillValid`.
 */

import type { Renderer } from '@ifc-lite/renderer';
import { sceneGeometryReleased } from '@/lib/geometry-backing/scene-released';
import { fedUnderVisibility, type ReadbackVisibility } from '@/lib/geometry-backing/readback-coverage';

let epoch = 0;
let chain: Promise<void> = Promise.resolve();
let queued = 0;

/** A reset gesture or a tool change: no readback queued before it may act. */
export function invalidatePendingMeasureReadbacks(): void { epoch++; }

/** Whether (x, y) can be raycast now without a new readback. */
export function readbackCovers(renderer: Renderer, x: number, y: number, visibility: ReadbackVisibility): boolean {
  return !sceneGeometryReleased(renderer) || (renderer.readbackRaycastCovers(x, y) && fedUnderVisibility(renderer, visibility));
}

/** Run `action` now, or after readback at (x, y) when it is needed and missing. Returns true if deferred. */
type Feed = (renderer: Renderer, x: number, y: number, visibility: ReadbackVisibility) => Promise<string>;
const realFeed: Feed = async (...args) => (await import('@/lib/geometry-backing/readback-measure')).feedReadbackAt(...args);
let defaultFeed: Feed = realFeed;
/** TEST ONLY: drive the gate's read step from a handler-level test; `null` restores the real feeder. */
export function setMeasureReadbackFeedForTest(feed: Feed | null): void { defaultFeed = feed ?? realFeed; }

export function runWithReadback(renderer: Renderer, x: number, y: number, visibility: ReadbackVisibility, action: () => void,
  stillValid: () => boolean = () => true, feed: Feed = defaultFeed): boolean {
  if (readbackCovers(renderer, x, y, visibility)) { action(); return false; }
  const mine = epoch;
  const valid = () => mine === epoch && stillValid();
  queued++;
  chain = chain.then(async () => {
    if (!valid()) return;
    let outcome = await feed(renderer, x, y, visibility);
    if (outcome === 'cancelled' && valid()) outcome = await feed(renderer, x, y, visibility); // a hover overtook it
    if (outcome === 'cancelled' || !valid()) return;
    action(); // fed, or answered (no hit / unavailable): the raycast then misses rather than measuring stale pieces
  }).catch((error: unknown) => console.error('[Measure] Geometry readback failed', error)).finally(() => { queued--; });
  return true;
}

/**
 * Run `action` after every gated readback queued so far (a double-click finish after its own deferred
 * clicks), or now when none is pending. Fenced like them. Returns true if deferred.
 */
export function runAfterMeasureReadbacks(action: () => void, stillValid: () => boolean = () => true): boolean {
  if (queued === 0) { action(); return false; }
  const mine = epoch;
  queued++;
  chain = chain.then(() => { if (mine === epoch && stillValid()) action(); }).finally(() => { queued--; });
  return true;
}

/** Settles once every queued gated readback has run (tests). */
export function measureReadbacksIdle(): Promise<void> { return chain; }
