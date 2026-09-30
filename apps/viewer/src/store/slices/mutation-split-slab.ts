/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Slab-like split (IfcSlab / IfcRoof / IfcPlate / IfcSpace) under the split
 * identity policy (`lib/split-guid.ts`, #6233): the piece with the larger
 * footprint area stays the source entity — its profile is rewritten in place
 * to the clipped polygon — and one new element is authored for the other.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { ViewerState } from '../index.js';
import { addSlabToStore, addRoofToStore, addPlateToStore, addSpaceToStore, reassignHostedOpeningsInStore, resolveSpatialAnchor, toNativeLength, type SpatialAnchor } from '@ifc-lite/create';
import { computeSlabSplitGeometry } from '@/lib/slab-edit.js';
import { keepsFirstPiece } from '@/lib/split-guid.js';
import { pointInPolygon, type Point2D } from '@/lib/polygon-clip.js';
import { openSplit, piece, type SplitEnv } from './mutation-split.js';
import { cloneElementMetadata } from '@/lib/metadata-clone.js';
import { planSlabOpeningCarry } from '@/lib/slab-opening-carry.js';
import { recordModellingEdit, type ModellingStore } from './mutation-modelling-records.js';
import type { AuthoredElement } from './authoredElement.js';

type Get = () => ViewerState;

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

function buildPiece(editor: StoreEditor, anchor: SpatialAnchor, env: SplitEnv, type: string, outline: Point2D[], thickness: number, baseElevation: number): { expressId: number; element: AuthoredElement } {
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

export function splitSlab(
  get: Get,
  editorFor: (modelId: string) => StoreEditor | null,
  modelId: string,
  expressId: number,
  cutA: [number, number],
  cutB: [number, number],
  store: ModellingStore,
) {
  const open = openSplit(get, editorFor, modelId, expressId, 'slab');
  if (!open.ok) return open;
  const { env, chain } = open;
  const geo = computeSlabSplitGeometry(chain, cutA, cutB);
  if (!geo.ok) return geo;
  // "First" is the piece holding the profile's start vertex (the tie-break).
  const leftIsFirst = holds(geo.leftFootprint, chain.footprint[0]);
  const [first, second] = leftIsFirst ? [geo.leftFootprint, geo.rightFootprint] : [geo.rightFootprint, geo.leftFootprint];
  const keepFirst = keepsFirstPiece(polygonArea(first), polygonArea(second));
  const kept = keepFirst ? first : second;
  const cut = keepFirst ? second : first;

  let added: ReturnType<typeof buildPiece>;
  try {
    const moves = planSlabOpeningCarry(env, expressId, chain, cut, cutA, cutB, chain.baseElevation);
    added = recordModellingEdit(store, modelId, (_methods, draft) => {
      const view = draft.getMutationView(), anchor = resolveSpatialAnchor(env.dataStore, env.storeyExpressId, view);
      const added = buildPiece(draft, anchor, env, chain.elementType, cut, geo.thickness, chain.baseElevation);
      const origin = chain.placementOrigin;
      const emitted = emitClippedProfile(draft, kept, origin, chain.baseElevation - origin[2], env.lengthUnitScale);
      draft.setPositionalAttribute(chain.extrudedSolidId, 0, `#${emitted.profile}`);
      draft.setPositionalAttribute(chain.extrudedSolidId, 1, `#${emitted.solidPosition}`);
      draft.setPositionalAttribute(chain.extrudedSolidId, 2, `#${emitted.up}`);
      reassignHostedOpeningsInStore(env.dataStore, draft, expressId, moves.map(move => ({ ...move, hostId: added.expressId })));
      cloneElementMetadata(env.dataStore, view, draft, expressId, [added.expressId]);
      return added;
    });
  } catch (error) {
    return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
  }
  get().recordAuthoredElement(modelId, env.storeyExpressId, added.expressId, added.element, { historyRecorded: true });
  const [leftId, rightId] = keepFirst === leftIsFirst ? [expressId, added.expressId] : [added.expressId, expressId];
  return { ok: true as const, left: piece(get, modelId, leftId), right: piece(get, modelId, rightId) };
}
