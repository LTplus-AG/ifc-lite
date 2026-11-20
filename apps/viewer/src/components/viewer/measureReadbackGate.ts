/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Readback for measure actions over released CPU geometry (#10264). A released
 * scene answers a raycast only from pieces read back for that exact point, so a
 * drag, polyline, radius or angle point that no hover prepared reads its own
 * point back first, then acts. Resident scenes act synchronously, as before.
 *
 * - Reads run one after another; each action is fenced by its own validity and
 *   by `invalidatePendingMeasureReadbacks` (a press, Esc, a tool change).
 * - An action runs only on `fed` or `no-hit`. A `cancelled` read (a newer read
 *   took the feeder) is retried once; an `unavailable` one (an unbacked front
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

let epoch = 0;
let chain: Promise<void> = Promise.resolve();

/** A press, Esc or a tool change: no read queued before it may act. */
export function invalidatePendingMeasureReadbacks(): void { epoch++; }

/** Whether a read outcome may be acted on as a real answer for that point. */
export const answered = (outcome: string): boolean => outcome === 'fed' || outcome === 'no-hit' || outcome === 'resident';

/** Run `action` now (resident), or after reading (x, y) back. Returns true if deferred. */
export function runWithReadback(renderer: Renderer, x: number, y: number, visibility: Visibility, action: () => void,
  stillValid: () => boolean = () => true): boolean {
  if (!sceneGeometryReleased(renderer)) { action(); return false; }
  const mine = epoch;
  const valid = () => mine === epoch && stillValid();
  chain = chain.then(async () => {
    if (!valid()) return;
    let outcome = await feed(renderer, x, y, visibility);
    if (outcome === 'cancelled' && valid()) outcome = await feed(renderer, x, y, visibility);
    if (valid() && answered(outcome)) action();
  }).catch((error: unknown) => console.error('[Measure] Geometry readback failed', error));
  return true;
}

/** Settles once every queued read has run (tests). */
export function measureReadbacksIdle(): Promise<void> { return chain; }
