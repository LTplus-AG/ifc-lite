/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * On-demand readback for measure entry points that have no hover in front of
 * them (a touch tap, a click after the view moved, a drag) on a scene whose CPU
 * geometry was released (#10264). The renderer answers readback pieces only
 * for the exact ray they were prepared for, so an uncovered entry point prepares
 * readback at its own coordinates and re-runs once it is ready. Resident scenes
 * run synchronously, exactly as before.
 */

import type { Renderer } from '@ifc-lite/renderer';
import { sceneGeometryReleased } from '@/lib/geometry-backing/scene-released';

type Visibility = { hiddenIds?: ReadonlySet<number>; isolatedIds?: ReadonlySet<number> | null };

/** Run `action` now, or after readback at (x, y) when it is needed and missing. Returns true if deferred. */
export function runWithReadback(renderer: Renderer, x: number, y: number, visibility: Visibility, action: () => void): boolean {
  if (!sceneGeometryReleased(renderer) || renderer.readbackRaycastCovers(x, y)) { action(); return false; }
  void import('@/lib/geometry-backing/readback-measure')
    .then((m) => m.feedReadbackAt(renderer, x, y, visibility))
    .then(action, (error: unknown) => console.error('[Measure] Geometry readback failed', error));
  return true;
}
