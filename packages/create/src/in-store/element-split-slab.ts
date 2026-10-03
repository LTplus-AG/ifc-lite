/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { editOwnershipRefusal } from '@ifc-lite/export';
import type { StoreEditor } from '@ifc-lite/mutations';
import { addSlabToStore } from './slab.js';
import { addRoofToStore } from './roof.js';
import { addPlateToStore } from './plate.js';
import { addSpaceToStore } from './space.js';
import { reassignHostedOpeningsInStore } from './hosted-placement-edit.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { toNativeLength, type SpatialAnchor } from './anchor.js';
import { computeSlabSplitGeometry } from './edit/slab-edit.js';
import { keepsFirstPiece } from './edit/split-guid.js';
import { pointInPolygon, type Point2D } from './edit/polygon-clip.js';
import { cloneElementMetadata } from './edit/metadata-clone.js';
import { planSlabOpeningCarry } from './edit/slab-opening-carry.js';
import type { SlabSplitChain } from './edit/split-target.js';
import type { ElementSplitResult, SplitEnvironment } from './element-split.js';
import type { OrdinaryInStoreElement } from './ordinary-element.js';
function polygonArea(points: readonly Point2D[]): number {
  let a = 0;
  points.forEach(([x1, y1], i) => {
    const [x2, y2] = points[(i + 1) % points.length];
    a += x1 * y2 - x2 * y1;
  });
  return Math.abs(a / 2);
}

/** Whether `polygon` holds `p` — on a vertex / edge counts, as a clipped half keeps the source's corners. */
function holds(polygon: Point2D[], p: Point2D): boolean {
  return polygon.some(([x, y]) => Math.abs(x - p[0]) < 1e-9 && Math.abs(y - p[1]) < 1e-9) || pointInPolygon(polygon, p);
}

/**
 * A closed polyline profile at `outline` minus `origin` (the source placement's
 * origin), in native units, on an unrotated solid position `rise` above the
 * placement, extruded straight up: the rewrite places the clipped footprint
 * exactly where the chain reader measured it, at the height the source's
 * extrusion started (`baseElevation`: the split predicate only accepts
 * vertical extrusions, which may start below their placement, #6233).
 */
export function emitClippedProfile(editor: StoreEditor, outline: readonly Point2D[], origin: readonly number[], rise: number, k: number) {
  const n = (v: number) => toNativeLength({ lengthUnitScale: k }, v);
  const ids = [...outline, outline[0]].map(([x, y]) =>
    editor.addEntity('IfcCartesianPoint', [[n(x - origin[0]), n(y - origin[1])]]).expressId);
  const polyline = editor.addEntity('IfcPolyline', [ids.map((id) => `#${id}`)]).expressId;
  const profile = editor.addEntity('IfcArbitraryClosedProfileDef', ['.AREA.', null, `#${polyline}`]).expressId;
  const solidOrigin = editor.addEntity('IfcCartesianPoint', [[0, 0, n(rise)]]).expressId;
  const solidPosition = editor.addEntity('IfcAxis2Placement3D', [`#${solidOrigin}`, null, null]).expressId;
  const up = editor.addEntity('IfcDirection', [[0, 0, 1]]).expressId;
  return { profile, solidPosition, up };
}

function buildPiece(editor: StoreEditor, anchor: SpatialAnchor, env: SplitEnvironment, type: string, outline: Point2D[], thickness: number, baseElevation: number): { expressId: number; element: OrdinaryInStoreElement } {
  const base = { Profile: 'polygon' as const, Position: [0, 0, baseElevation] as [number, number, number], OuterCurve: outline, Name: env.name, GlobalId: env.newGlobalId };
  const params = { ...base, Thickness: thickness };
  switch (type) {
    case 'IfcSlab': return { expressId: addSlabToStore(editor, anchor, params).slabId, element: { kind: 'slab', params } };
    case 'IfcRoof': return { expressId: addRoofToStore(editor, anchor, params).roofId, element: { kind: 'roof', params } };
    case 'IfcPlate': return { expressId: addPlateToStore(editor, anchor, params).plateId, element: { kind: 'plate', params } };
    default: {
      const params = { ...base, Height: thickness };
      return { expressId: addSpaceToStore(editor, anchor, params).spaceId, element: { kind: 'space', params } };
    }
  }
}

export function splitSlabDraft(env: SplitEnvironment, expressId: number, chain: SlabSplitChain, cutA: Point2D, cutB: Point2D): ElementSplitResult {
  const ownership = editOwnershipRefusal(env.dataStore, env.view, [chain.extrudedSolidId], new Set([expressId]));
  if (ownership) throw new Error(ownership);
  const geo = computeSlabSplitGeometry(chain, cutA, cutB);
  if (!geo.ok) throw new Error(geo.reason);
  const leftIsFirst = holds(geo.leftFootprint, chain.footprint[0]);
  const [first, second] = leftIsFirst ? [geo.leftFootprint, geo.rightFootprint] : [geo.rightFootprint, geo.leftFootprint];
  const keepFirst = keepsFirstPiece(polygonArea(first), polygonArea(second));
  const kept = keepFirst ? first : second, cut = keepFirst ? second : first;
  const moves = planSlabOpeningCarry(env, expressId, chain, cut, cutA, cutB, chain.baseElevation);
  const { editor, dataStore, view } = env;
  const anchor = resolveSpatialAnchor(dataStore, env.storeyExpressId, view);
  const added = buildPiece(editor, anchor, env, chain.elementType, cut, geo.thickness, chain.baseElevation);
  const origin = chain.placementOrigin;
  const emitted = emitClippedProfile(editor, kept, origin, chain.baseElevation - origin[2], env.lengthUnitScale);
  editor.setPositionalAttribute(chain.extrudedSolidId, 0, `#${emitted.profile}`);
  editor.setPositionalAttribute(chain.extrudedSolidId, 1, `#${emitted.solidPosition}`);
  editor.setPositionalAttribute(chain.extrudedSolidId, 2, `#${emitted.up}`);
  reassignHostedOpeningsInStore(dataStore, editor, expressId, moves.map(move => ({ ...move, hostId: added.expressId })));
  cloneElementMetadata(dataStore, view, editor, expressId, [added.expressId]);
  const [leftId, rightId] = keepFirst === leftIsFirst ? [expressId, added.expressId] : [added.expressId, expressId];
  return { sourceId: expressId, addedId: added.expressId, leftId, rightId, storeyId: env.storeyExpressId, element: added.element,
    openings: { toLeft: 0, toRight: 0, skipped: 0 } };
}
