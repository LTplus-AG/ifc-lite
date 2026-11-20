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
 */

import type { Renderer } from '@ifc-lite/renderer';
import { sceneGeometryReleased } from '@/lib/geometry-backing/scene-released';

type Visibility = { hiddenIds?: ReadonlySet<number>; isolatedIds?: ReadonlySet<number> | null };
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
export function runWithReadback(renderer: Renderer, x: number, y: number, visibility: Visibility, action: () => void,
  stillValid: () => boolean = () => true, kind: 'preview' | 'placement' = 'preview'): boolean {
  if (!sceneGeometryReleased(renderer)) { action(); return false; }
  const mine = epoch;
  const valid = () => (kind === 'placement' || mine === epoch) && stillValid();
  chain = chain.then(async () => {
    if (!valid()) return;
    // A newer read (a moving hover) took the feeder: read again. A preview retries once; a placement keeps
    // retrying while it is valid (bounded), so a click is never dropped because the pointer kept moving.
    let outcome = await feed(renderer, x, y, visibility);
    for (let tries = kind === 'placement' ? PLACEMENT_RETRIES : 1; outcome === 'cancelled' && valid() && tries > 0; tries--) {
      outcome = await feed(renderer, x, y, visibility);
    }
    if (outcome === 'cancelled' && kind === 'placement' && valid()) console.warn('[Measure] Point not placed: geometry readback kept being superseded');
    if (valid() && answered(outcome)) action();
  }).catch((error: unknown) => console.error('[Measure] Geometry readback failed', error));
  return true;
}

/**
 * A hover preview: `run` now (resident), else after its own read, latest wins. It acts only on an answered
 * read; an `unavailable` one (never raycast past an unbacked front: it could snap to a point cloud behind)
 * clears the preview via `clear`. A `cancelled` one was superseded by a newer read, which acts instead.
 */
export function hoverWithReadback(renderer: Renderer, x: number, y: number, visibility: Visibility, run: () => void,
  stillValid: () => boolean, clear: () => void): void {
  if (!sceneGeometryReleased(renderer)) { run(); return; }
  const mine = ++hoverRead;
  void feed(renderer, x, y, visibility).then((outcome) => {
    if (mine !== hoverRead || !stillValid()) return;
    if (answered(outcome)) run(); else if (outcome === 'unavailable') clear();
  }, (error: unknown) => console.error('[Measure] Geometry readback failed', error));
}

/** Settles once every queued read has run (tests). */
export function measureReadbacksIdle(): Promise<void> { return chain; }
