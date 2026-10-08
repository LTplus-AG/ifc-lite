/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SectionCapStyle } from '@ifc-lite/renderer';
import type { SectionPlaneAxis } from './types';
import type { AlignmentSectionBinding } from '@/lib/section/alignment-contract';

/**
 * Custom (face-picked) plane override. When present, the renderer uses
 * `normal` + `distance` directly and ignores `axis` / `position`, and
 * `SectionPlane.flipped` is relative to `normal`, not to the cardinal axis
 * (#5644): the shader's `side` multiplies `dot(p, normal) - distance`. The
 * cardinal `axis` / `position` fields are still kept in sync
 * (nearest-cardinal for axis, percentage along it for position; read the
 * matching flip through `cardinalSectionFlipped`) so any
 * downstream reader that pre-dates custom planes (drawings export, BCF
 * snapshots, view controls) still gets a sensible projection rather than
 * crashing or emitting empty data.
 *
 * Tangent + bitangent are derived once at pick time from `normal` via the
 * deterministic `planeBasis` helper so the cap shader and cutter share
 * exactly one orientation — without this the cap-hatch can rotate when
 * the renderer re-derives the basis on every frame.
 */
export interface CustomSectionPlane {
  /** Bound station; a manual plane edit detaches this association. */
  alignment?: AlignmentSectionBinding;
  /** Unit world-space normal. */
  normal: [number, number, number];
  /** Signed plane offset in world units: `dot(pointOnPlane, normal)`. */
  distance: number;
  /** World-space hit point at pick time (anchors the slider re-mapping). */
  pickedAt: [number, number, number];
  /** First in-plane axis, deterministic from `normal`. */
  tangent: [number, number, number];
  /** Second in-plane axis, deterministic from `normal`. */
  bitangent: [number, number, number];
}

/** An axis-aligned world-space section box (#5513): the renderer's `ClipBox` without its flag. */
export interface SectionBox {
  min: [number, number, number];
  max: [number, number, number];
}
/** One of the six faces of a `SectionBox`, named by corner and axis. */
export type SectionBoxFace = 'minX' | 'maxX' | 'minY' | 'maxY' | 'minZ' | 'maxZ';

export interface SectionPlane {
  axis: SectionPlaneAxis;
  /** 0-100 percentage of model bounds */
  position: number;
  enabled: boolean; // the cut is defined and turned on; ON SCREEN also requires `sceneState.section.visible` (#5893)
  parked?: boolean; // enabled, but hidden by the visibility toggle (`sceneState.section.visible === false`, #5893)
  flipped: boolean; // show the opposite side of the cut
  /** Whether to render the filled, hatched cap surface at the plane. Defaults to true. */
  showCap: boolean;
  /**
   * Whether to draw polygon outlines on top of the cut (the crisp black
   * line the architect expects around each sliced element). Independent
   * from `showCap` so users can have a hatched fill without outlines,
   * or vice versa. Defaults to true.
   */
  showOutlines: boolean;
  /** User-defined colour + hatch for the cut surface. */
  capStyle: SectionCapStyle;
  /**
   * Optional arbitrary-normal override populated by face-pick. When set,
   * the renderer cuts on this plane verbatim; cardinal `axis` / `position`
   * are kept in sync as the closest cardinal projection (see
   * `CustomSectionPlane`).
   */
  custom?: CustomSectionPlane;
  /** Box mode (#5513): the cut is this box, not a plane; exclusive with `custom`. */
  box?: SectionBox;
}
