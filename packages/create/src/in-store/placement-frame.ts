/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Planar rigid frames read out of an `IfcLocalPlacement` chain, and the algebra
 * for composing, inverting and applying them.
 *
 * Split out of `extract-walls.ts` so the storey frame has ONE implementation.
 * `extract-walls` needs it to express wall axes and existing space footprints
 * storey-locally; `storey-plan-frame.ts` needs the same chain composed all the
 * way to the model's own world frame, so a producer working in that frame can
 * divide the storey out before authoring into a storey-local slot. Two copies
 * of the composition order or of `invertFrame`'s sign convention would put the
 * read side and the write side on coordinates that differ by a rotation, which
 * is exactly the failure the storey-local contract exists to prevent.
 *
 * Every frame here is 2D and in the file's own raw length unit: the Z-up ground
 * plane of the IFC coordinates, unscaled. Callers that speak metres apply the
 * length-unit scale themselves.
 */

import {
  EntityExtractor,
  type IfcDataStore,
  type IfcAttributeValue,
} from '@ifc-lite/parser';
import type { Vec2 } from './auto-space-detect.js';

/**
 * Optional overlay reader. If supplied, overlay walls (entities
 * created via `editor.addEntity('IfcWall', ...)` since the model was
 * parsed) are included alongside the source walls.
 */
export interface OverlayWallReader {
  /** Iterate every overlay-created entity. */
  getNewEntities(): Iterable<{ expressId: number; type: string; attributes: IfcAttributeValue[] }>;
  /** Resolve a positional attribute (with mutations applied). */
  getAttribute?(expressId: number, index: number): IfcAttributeValue | undefined;
}

export const AXIS_EPS = 1e-6;

export interface PlacementFrame {
  /** Placement origin in storey-local 2D (X, Y). */
  origin: Vec2;
  /** Local X axis (RefDirection) projected onto the ground plane. */
  axisX: Vec2;
}

/**
 * Walk IfcLocalPlacement → IfcAxis2Placement3D → CartesianPoint and read the
 * ground-plane origin + RefDirection *of this one placement*, i.e. expressed
 * in its own `PlacementRelTo` parent's frame. Returns null when any link is
 * missing.
 */
export function readOwnPlacementFrame(
  store: IfcDataStore,
  extractor: EntityExtractor,
  overlay: OverlayWallReader | undefined,
  placementId: number,
): PlacementFrame | null {
  const placement = readEntity(store, extractor, overlay, placementId);
  if (!placement) return null;
  const axisPlacementId = numericAttr(placement.attributes[1]);
  if (axisPlacementId === null) return null;
  const axisPlacement = readEntity(store, extractor, overlay, axisPlacementId);
  if (!axisPlacement) return null;
  const locationId = numericAttr(axisPlacement.attributes[0]);
  const refDirId = numericAttr(axisPlacement.attributes[2]);
  if (locationId === null) return null;
  const locationEnt = readEntity(store, extractor, overlay, locationId);
  if (!locationEnt) return null;
  const origin = readVec3(locationEnt.attributes[0]);
  if (!origin) return null;

  let axisX: Vec2 = [1, 0];
  if (refDirId !== null) {
    const refDir = readEntity(store, extractor, overlay, refDirId);
    if (refDir) {
      const dir = readVec3(refDir.attributes[0]);
      if (dir) {
        const len = Math.hypot(dir[0], dir[1]);
        if (len > AXIS_EPS) axisX = [dir[0] / len, dir[1] / len];
      }
    }
  }
  return { origin: [origin[0], origin[1]], axisX };
}

/**
 * The storey's OWN placement chain: its `ObjectPlacement` and every ancestor
 * reachable from it via `IfcLocalPlacement.PlacementRelTo`, mapped to the
 * number of hops from the storey's own placement (`0` for that placement
 * itself). Composition stops when it reaches one of these, and the hop count
 * says how much of the storey's own chain still separates the stopping point
 * from the storey frame — see `frameInStoreyFrame`.
 *
 * Returns `null` — NOT an empty map — when the storey has no resolvable
 * placement, which `IfcProduct.ObjectPlacement` being OPTIONAL makes a
 * well-formed possibility. An empty map is not "no storey frame", it is
 * "a storey frame the walk can never reach": the walk would find nothing to
 * stop on and compose every hop up to the world root, labelling world
 * coordinates storey-local. `frameInStoreyFrame` treats `null` as "compose
 * nothing" instead — see there.
 */
export function storeyPlacementChain(
  store: IfcDataStore,
  extractor: EntityExtractor,
  overlay: OverlayWallReader | undefined,
  storeyId: number,
): Map<number, number> | null {
  const chain = new Map<number, number>();
  const storey = readEntity(store, extractor, overlay, storeyId);
  if (!storey) return null;
  let id = numericAttr(storey.attributes[5]); // ObjectPlacement
  if (id === null) return null;
  while (id !== null && !chain.has(id)) {
    chain.set(id, chain.size);
    const placement = readEntity(store, extractor, overlay, id);
    if (!placement) break;
    id = numericAttr(placement.attributes[0]); // PlacementRelTo
  }
  return chain;
}

/**
 * The storey's frame expressed in the frame of the chain entry `hops` steps
 * above its own placement: compose the storey's first `hops` placements, the
 * innermost one first. `hops === 0` is the storey's own placement, whose frame
 * relative to itself is the identity.
 *
 * Returns `null` when any of those placements has no readable frame — the
 * caller must then leave the element where it is rather than move it by a
 * partial chain.
 */
export function storeyFrameAboveBy(
  store: IfcDataStore,
  extractor: EntityExtractor,
  overlay: OverlayWallReader | undefined,
  storeyChain: ReadonlyMap<number, number>,
  hops: number,
): PlacementFrame | null {
  let frame: PlacementFrame = { origin: [0, 0], axisX: [1, 0] };
  let composed = 0;
  for (const id of storeyChain.keys()) {
    if (composed >= hops) break;
    const own = readOwnPlacementFrame(store, extractor, overlay, id);
    if (!own) return null;
    frame = composeFrames(own, frame);
    composed += 1;
  }
  return composed === hops ? frame : null;
}

/**
 * The inverse of a planar rigid frame: `invertFrame(f)` maps a point expressed
 * in `f`'s parent frame back into `f`'s own frame, so
 * `composeFrames(invertFrame(f), g)` re-expresses `g` — a sibling of `f` in
 * that parent frame — relative to `f`.
 *
 * With `axisX = (c, s)` the frame applies `p ↦ R·p + origin`, `R = [[c,−s],
 * [s,c]]`. The inverse applies `p ↦ Rᵀ·(p − origin)`, and `Rᵀ` is the rotation
 * whose `axisX` is `(c, −s)`, which is why only the Y component flips.
 */
export function invertFrame(frame: PlacementFrame): PlacementFrame {
  const c = frame.axisX[0];
  const s = frame.axisX[1];
  const [ox, oy] = frame.origin;
  return { origin: [-(c * ox + s * oy), -(-s * ox + c * oy)], axisX: [c, -s] };
}

/**
 * Compose `inner` (expressed in `outer`'s frame) with `outer`, giving the
 * frame of `inner` expressed in whatever frame `outer` is expressed in.
 */
export function composeFrames(outer: PlacementFrame, inner: PlacementFrame): PlacementFrame {
  const ax = outer.axisX[0];
  const ay = outer.axisX[1];
  // Perpendicular = rotate axisX 90° CCW around +Z — same convention as
  // `applyFrame`, which this must agree with exactly.
  const px = -ay;
  const py = ax;
  return {
    origin: applyFrame(outer, inner.origin),
    // Directions rotate but do not translate.
    axisX: [ax * inner.axisX[0] + px * inner.axisX[1], ay * inner.axisX[0] + py * inner.axisX[1]],
  };
}

/**
 * Frame of `placementId` expressed in the STOREY's frame: this placement's
 * own frame composed with every intermediate `IfcLocalPlacement.
 * PlacementRelTo` hop, stopping *before* the storey's own placement.
 *
 * An element's `ObjectPlacement` is not always one hop from its storey. The
 * IFC-standard grouping pattern — an `IfcElementAssembly` for a curtain
 * wall, precast panel run or railing system, all of them in
 * `DEFAULT_DIVIDER_TYPES` — inserts an intermediate `IfcLocalPlacement`
 * between the member and the storey. Reading only the member's own
 * `RelativePlacement` silently drops that hop's translation and rotation, so
 * the member is extracted at the wrong position relative to walls placed
 * directly under the storey: corners that should meet come out disconnected
 * and the enclosed room is never detected.
 *
 * Composition deliberately STOPS at the storey rather than continuing to the
 * root. Storey-local is the frame the write side uses: `generateSpacesFromWalls`
 * hands these segments to `addSpaceToStore`, which authors the new `IfcSpace`
 * with `anchor.storeyPlacementId` as its `PlacementRelTo` (see `space.ts` and
 * `resolve-anchor.ts`). Composing to the root would bake the storey's own
 * offset into the coordinates and the storey placement would then apply it a
 * second time, putting the space a whole site-offset away from its room.
 *
 * A `null` `storeyChain` (storey with no `ObjectPlacement`) means there is no
 * storey frame to compose towards, so no hop is composed at all.
 */
export function frameInStoreyFrame(
  store: IfcDataStore,
  extractor: EntityExtractor,
  overlay: OverlayWallReader | undefined,
  placementId: number,
  storeyChain: ReadonlyMap<number, number> | null,
): PlacementFrame | null {
  let frame = readOwnPlacementFrame(store, extractor, overlay, placementId);
  if (!frame) return null;
  // No storey placement at all (`ObjectPlacement` is OPTIONAL): there is no
  // storey frame to compose towards and nothing for the walk to stop on, so
  // walking parents would run to the world root and return world coordinates
  // where every caller expects storey-local ones. Compose nothing — the
  // element's own frame, which is what this returned before the chain walk
  // existed — and leave the element where its own placement puts it rather
  // than silently moving it by the site and building offsets.
  if (!storeyChain) return frame;
  // Visited-set termination: exact for cyclic/self-referential
  // `PlacementRelTo` in malformed IFC, and needs no arbitrary depth bound.
  const visited = new Set<number>([placementId]);
  let currentId = placementId;
  for (;;) {
    const placement = readEntity(store, extractor, overlay, currentId);
    const relToId = placement ? numericAttr(placement.attributes[0]) : null;
    // The walk joins the storey's own chain (or runs out of parents at the
    // root, where the storey's chain also ends). `frame` is now expressed in
    // that shared ancestor's frame, and the storey sits `hops` placements
    // below it — `hops === 0` when the ancestor IS the storey's placement,
    // the common shape, where the frame is already storey-local.
    if (relToId === null || storeyChain.has(relToId)) {
      const hops = relToId === null ? storeyChain.size : (storeyChain.get(relToId) as number);
      if (hops === 0) return frame;
      // #3003: the wall joined the chain ABOVE the storey, so the storey's own
      // hops are in `frame` and every caller reads the result as storey-local.
      // Divide them out — the INVERSE of the storey's frame in the shared
      // ancestor, applied to the wall's frame in that same ancestor. Applying
      // the storey frame itself instead would double the offset rather than
      // remove it, so the two directions land on different coordinates and the
      // #3003 fixture pins which one this is.
      const storeyFrame = storeyFrameAboveBy(store, extractor, overlay, storeyChain, hops);
      return storeyFrame ? composeFrames(invertFrame(storeyFrame), frame) : frame;
    }
    // A cycle in a malformed `PlacementRelTo`: nothing above is trustworthy,
    // so stop with what has been composed so far.
    if (visited.has(relToId)) return frame;
    const parent = readOwnPlacementFrame(store, extractor, overlay, relToId);
    if (!parent) return frame;
    frame = composeFrames(parent, frame);
    visited.add(relToId);
    currentId = relToId;
  }
}

/**
 * Apply a placement frame to a storey-local 2D point. The point's X is
 * along the wall's local axis; Y is perpendicular (perpendicular to
 * the wall direction in the ground plane).
 */
export function applyFrame(frame: PlacementFrame, local: Vec2): Vec2 {
  const ax = frame.axisX[0];
  const ay = frame.axisX[1];
  // Perpendicular = rotate axisX 90° CCW around +Z.
  const px = -ay;
  const py = ax;
  return [
    frame.origin[0] + ax * local[0] + px * local[1],
    frame.origin[1] + ay * local[0] + py * local[1],
  ];
}

export function readEntity(
  store: IfcDataStore,
  extractor: EntityExtractor,
  overlay: OverlayWallReader | undefined,
  expressId: number,
): { type?: string; attributes: IfcAttributeValue[] } | null {
  const ref = store.entityIndex.byId.get(expressId);
  if (ref && ref.byteLength > 0 && ref.byteOffset >= 0) {
    return extractor.extractEntity(ref);
  }
  // Overlay-only entity: fall back to the overlay reader.
  if (overlay) {
    for (const ent of overlay.getNewEntities()) {
      if (ent.expressId === expressId) {
        return { type: ent.type, attributes: ent.attributes };
      }
    }
  }
  return null;
}

export function numericAttr(v: IfcAttributeValue | undefined): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (v.startsWith('#')) {
      const n = Number(v.slice(1));
      return Number.isFinite(n) ? n : null;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function readVec3(v: IfcAttributeValue | undefined): [number, number, number] | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const x = numericAttr(v[0]);
  const y = numericAttr(v[1]);
  const z = v.length >= 3 ? numericAttr(v[2]) : 0;
  if (x === null || y === null || z === null) return null;
  return [x, y, z];
}