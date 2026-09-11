/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The storey's own plan frame, expressed in the MODEL'S WORLD FRAME — the whole
 * `IfcLocalPlacement` chain the storey hangs from (storey axis ∘ building ∘
 * site ∘ …), composed, in metres — plus the two folds between that frame and
 * the storey-local one.
 *
 * Why this exists. `addSpaceToStore` authors the outer curve under a placement
 * whose `PlacementRelTo` is the storey's own placement, so every coordinate it
 * is handed is read back through that chain. A producer that already works in
 * world coordinates — anything derived from rendered geometry, which has the
 * chain baked in — must therefore divide the chain out first, or the reader
 * applies it a second time and the room lands a whole site offset and rotation
 * away from the walls it was drawn between. The headless producers
 * (`extractWallSegmentsForStorey`, `existingSpaceFootprintsByStorey`) are
 * storey-local for exactly this reason; these two functions let a world-frame
 * producer join them.
 *
 * Refusing rather than guessing is deliberate in both failure modes below. A
 * subtly turned room is not visible in the tool that drew it: it shows up when
 * somebody else opens the exported file, or when the area is quoted in a
 * schedule.
 */

import { EntityExtractor, extractLengthUnitScale, type IfcDataStore } from '@ifc-lite/parser';
import type { Vec2 } from './auto-space-detect.js';
import {
  numericAttr,
  readEntity,
  readVec3,
  storeyFrameAboveBy,
  storeyPlacementChain,
} from './placement-frame.js';

/**
 * A storey's placement chain reduced to a planar rigid motion in the model's
 * world frame, in metres: `world = R · storeyLocal + origin`, with `R` the
 * rotation whose first column is `axisX`.
 */
export interface StoreyPlanFrame {
  /** The storey origin in world-frame metres. */
  origin: Vec2;
  /** The storey's local X axis in the world frame, unit length. */
  axisX: Vec2;
}

/** A placement `Axis` is treated as vertical within this of unit +Z. */
const VERTICAL_EPS = 1e-6;

/** The frame of a storey that carries no placement at all: no transform. */
const IDENTITY_FRAME: StoreyPlanFrame = { origin: [0, 0], axisX: [1, 0] };

/**
 * Compose the storey's whole placement chain into a world-frame plan frame, in
 * metres.
 *
 * A storey with NO `ObjectPlacement` — it is OPTIONAL on `IfcProduct`, and real
 * files leave it out — gets the identity, which is the answer rather than a
 * guess: a product with no placement carries no transform, and the authoring
 * side materialises exactly that (an `IfcLocalPlacement` at the origin with no
 * `PlacementRelTo`) before it writes.
 *
 * Returns `null` — refusing, never approximating — when:
 *  - the storey itself will not read, so there is nothing to say;
 *  - any link in the chain will not read (a missing `RelativePlacement`,
 *    `Location`, or a dangling reference), so only part of the chain could be
 *    composed and a partial chain moves the geometry by the wrong amount;
 *  - any link tips out of plan — an `IfcAxis2Placement3D.Axis` that is not
 *    +Z — because a tilted chain has no planar inverse, and projecting it
 *    yields a room that is turned rather than one that is obviously wrong.
 */
export function storeyPlanFrame(
  store: IfcDataStore,
  storeyExpressId: number,
): StoreyPlanFrame | null {
  if (!store.source) return null;
  const extractor = new EntityExtractor(store.source);
  const storey = readEntity(store, extractor, undefined, storeyExpressId);
  if (!storey) return null;
  if (numericAttr(storey.attributes[5]) === null) return IDENTITY_FRAME; // ObjectPlacement
  const chain = storeyPlacementChain(store, extractor, undefined, storeyExpressId);
  if (!chain || chain.size === 0) return null;
  for (const placementId of chain.keys()) {
    if (!placementIsInPlan(store, extractor, placementId)) return null;
  }
  // `hops === chain.size` composes every link, so the result is expressed in
  // the frame the topmost link's parent would be in — the world frame, since
  // that link has no `PlacementRelTo`.
  const frame = storeyFrameAboveBy(store, extractor, undefined, chain, chain.size);
  if (!frame) return null;
  let scale = 1;
  try {
    const raw = extractLengthUnitScale(store.source, store.entityIndex);
    if (Number.isFinite(raw) && raw > 0) scale = raw;
  } catch (error) {
    // A thrown unit lookup is not a reason to author a space a thousand times
    // too far out: the origin below is a translation in file units, so a
    // millimetre model read as metres moves the room by kilometres. Refuse.
    console.warn('storeyPlanFrame: failed to extract length unit scale', error);
    return null;
  }
  return { origin: [frame.origin[0] * scale, frame.origin[1] * scale], axisX: frame.axisX };
}

/**
 * World-frame point → the storey-local frame `addSpaceToStore` writes into:
 * `Rᵀ · (p − origin)`.
 */
export function toStoreyLocal(frame: StoreyPlanFrame, p: Vec2): Vec2 {
  const [c, s] = frame.axisX;
  const dx = p[0] - frame.origin[0];
  const dy = p[1] - frame.origin[1];
  return [c * dx + s * dy, -s * dx + c * dy];
}

/**
 * Storey-local point → the world frame: `R · p + origin`. The inverse of
 * {@link toStoreyLocal}, for reading storey-local geometry (an authored space
 * footprint) back into a world-frame comparison.
 */
export function fromStoreyLocal(frame: StoreyPlanFrame, p: Vec2): Vec2 {
  const [c, s] = frame.axisX;
  return [
    frame.origin[0] + c * p[0] - s * p[1],
    frame.origin[1] + s * p[0] + c * p[1],
  ];
}

/**
 * Whether one `IfcLocalPlacement`'s own axis keeps the chain in plan: its
 * `IfcAxis2Placement3D.Axis` is absent (the +Z default) or is +Z.
 *
 * A link that will not read at all is reported as in-plan here and caught by
 * `storeyFrameAboveBy` returning null instead, so the two checks do not
 * disagree about which failure the caller is told about.
 */
function placementIsInPlan(
  store: IfcDataStore,
  extractor: EntityExtractor,
  placementId: number,
): boolean {
  const placement = readEntity(store, extractor, undefined, placementId);
  if (!placement) return true;
  const axisPlacementId = numericAttr(placement.attributes[1]); // RelativePlacement
  if (axisPlacementId === null) return true;
  const axisPlacement = readEntity(store, extractor, undefined, axisPlacementId);
  if (!axisPlacement) return true;
  const axisId = numericAttr(axisPlacement.attributes[1]); // Axis
  if (axisId === null) return true;
  const axisDir = readEntity(store, extractor, undefined, axisId);
  if (!axisDir) return true;
  const v = readVec3(axisDir.attributes[0]);
  if (!v) return true;
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len === 0) return true;
  return Math.abs(v[0] / len) < VERTICAL_EPS
    && Math.abs(v[1] / len) < VERTICAL_EPS
    && v[2] / len > 0;
}
