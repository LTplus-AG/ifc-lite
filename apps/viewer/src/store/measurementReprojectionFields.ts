/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The single registry of measurement-slice fields that carry SCREEN
 * coordinates, and therefore go stale the moment the camera moves.
 *
 * Two pieces of code have to agree about this set, and three times they did
 * not — #2641 (polyline) and #2735 (angle) are both in this repo's history,
 * and the next kind added repeated it:
 *
 *  - `updateMeasurementScreenCoords` (store/slices/measurementSlice.ts)
 *    reprojects each of these fields once per frame.
 *  - `hasPendingMeasurementState` (utils/viewportUtils.ts) decides whether
 *    that pass runs AT ALL — Viewport.tsx consults it first.
 *
 * A field reprojected but not gated is dead code: with only that kind of
 * measurement on screen the gate says "nothing pending", the pass never
 * runs, and the symptom is identical to having written no reprojection at
 * all. A comment saying "these two are a pair" was tried, and did not hold.
 *
 * So neither side keeps its own list any more. The gate is DERIVED from this
 * registry (it iterates the keys), and the reprojection pass's `set()`
 * payload is typed as an exhaustive map over
 * {@link ReprojectedMeasurementField} — so a field added here without a
 * reprojection arm, or an arm added there without an entry here, is a
 * compile error rather than a runtime nothing.
 *
 * Keep this module dependency-free: `viewportUtils.ts` imports it and must
 * stay a pure, store-free unit.
 *
 * NOT every field holding a `MeasurePoint` belongs here. `pendingMeasurePoint`
 * (the legacy click-click flow's first point) and `snapTarget` also carry
 * screen coordinates and are deliberately absent from BOTH sides; adding one
 * here without an arm in the reprojection pass would not compile, which is
 * the intended way to have that conversation.
 */

/**
 * How a registered field reports "there is something here":
 *  - `list`     — an array of finished measurements; pending when non-empty.
 *  - `nullable` — a single in-progress gesture; pending when not null.
 */
export type ReprojectedFieldKind = 'list' | 'nullable';

export const REPROJECTED_MEASUREMENT_FIELDS = {
  /** Finished drag/click distance measurements. */
  measurements: 'list',
  /** The in-progress drag gesture. */
  activeMeasurement: 'nullable',
  /** In-progress multi-click polyline sequence (#2199 / #2641). */
  activePolyline: 'nullable',
  /** Finished multi-click polylines (#2641). */
  polylineMeasurements: 'list',
  /** In-progress angle sequence (#2735). */
  activeAngle: 'nullable',
  /** Finished angle measurements (#2735). */
  angleMeasurements: 'list',
  /** In-progress radius/diameter sequence (#2737 item 2). */
  activeRadius: 'nullable',
  /** Finished radius measurements (#2737 item 2). */
  radiusMeasurements: 'list',
} as const satisfies Record<string, ReprojectedFieldKind>;

/** Field names of {@link REPROJECTED_MEASUREMENT_FIELDS}. */
export type ReprojectedMeasurementField = keyof typeof REPROJECTED_MEASUREMENT_FIELDS;

/**
 * The registry's keys as an iterable. `Object.keys` widens to `string[]`, and
 * a widened key would silently defeat the gate's exhaustiveness.
 */
export const REPROJECTED_MEASUREMENT_FIELD_NAMES = Object.keys(
  REPROJECTED_MEASUREMENT_FIELDS,
) as ReprojectedMeasurementField[];
