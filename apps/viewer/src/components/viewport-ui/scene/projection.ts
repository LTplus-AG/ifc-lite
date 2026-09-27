/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared helpers every anchor site in the scene kernel needs, factored out
 * after the same two defects turned up independently in `useWorldAnchor`,
 * `AxisArrow` and `PlaneOutline` (#5636 review):
 *
 *  - **Visibility.** A `screen` point being non-null does NOT mean "show
 *    this" — a point can project to a real, truthy screen coordinate that
 *    is still outside the canvas (`offScreen: true`). Every visibility
 *    check in this kernel goes through {@link isAnchorVisible} so that
 *    fact is checked exactly once.
 *  - **Value-change wake.** A world point read through `() =>
 *    latest.current.foo` picks up a VALUE change automatically on the next
 *    dirty tick — but with a static camera and no anchor registration
 *    change, nothing schedules that next tick, so the change sits unread
 *    until an unrelated wake. {@link useWakeOnChange} closes that gap: it
 *    reduces one or more world points to a single stable string key via
 *    {@link vec3Key} and wakes the projector whenever that key changes.
 */

import type { AnchorProjection, Vec3 } from './types';

/** True only when the projection has a screen point AND it's within the canvas. */
export function isAnchorVisible(projection: AnchorProjection | null | undefined): boolean {
  return !!projection?.screen && !projection.offScreen;
}

/** A stable string key for a world point (or `null`), suitable as a `useEffect`/`useWakeOnChange` dependency — `null` and every distinct coordinate compare distinctly, everything else compares equal. */
export function vec3Key(v: Vec3 | null | undefined): string {
  return v ? `${v.x},${v.y},${v.z}` : 'null';
}
