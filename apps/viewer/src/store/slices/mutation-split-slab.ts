/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Slab-like split (IfcSlab / IfcRoof / IfcPlate / IfcSpace) under the split
 * identity policy (`lib/split-guid.ts`, #6233): the piece with the larger
 * footprint area stays the source entity — its profile is rewritten in place
 * to the clipped polygon — and one new element is authored for the other.
 */

import type { StoreApi } from 'zustand';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { ViewerState } from '../index.js';
import type { AuthoredElement } from './authoredElement.js';
import { toNativeLength } from '@ifc-lite/create';
import { computeSlabSplitGeometry } from '@/lib/slab-edit.js';
import { keepsFirstPiece } from '@/lib/split-guid.js';
import { pointInPolygon, type Point2D } from '@/lib/polygon-clip.js';
import { closeSplit, openSplit, piece, reshapeSource, sourceMesh, type SplitEnv } from './mutation-split.js';

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
 * plan origin), in native units, and an identity solid position: the rewrite
 * places the clipped footprint exactly where the chain reader measured it.
 */
function emitClippedProfile(editor: StoreEditor, outline: readonly Point2D[], origin: readonly number[], k: number) {
  const ids = [...outline, outline[0]].map(([x, y]) =>
    editor.addEntity('IfcCartesianPoint', [[toNativeLength({ lengthUnitScale: k }, x - origin[0]), toNativeLength({ lengthUnitScale: k }, y - origin[1])]]).expressId);
  const polyline = editor.addEntity('IfcPolyline', [ids.map((id) => `#${id}`)]).expressId;
  const profile = editor.addEntity('IfcArbitraryClosedProfileDef', ['.AREA.', null, `#${polyline}`]).expressId;
  const solidOrigin = editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
  const solidPosition = editor.addEntity('IfcAxis2Placement3D', [`#${solidOrigin}`, null, null]).expressId;
  return { profile, solidPosition };
}

function addPiece(get: Get, modelId: string, env: SplitEnv, type: string, outline: Point2D[], thickness: number) {
  const base = { Profile: 'polygon' as const, Position: [0, 0, 0] as [number, number, number], OuterCurve: outline, Name: env.name, GlobalId: env.newGlobalId };
  const s = get();
  switch (type) {
    case 'IfcSlab': return s.addSlab(modelId, env.storeyExpressId, { ...base, Thickness: thickness });
    case 'IfcRoof': return s.addRoof(modelId, env.storeyExpressId, { ...base, Thickness: thickness });
    case 'IfcPlate': return s.addPlate(modelId, env.storeyExpressId, { ...base, Thickness: thickness });
    default: return s.addSpace(modelId, env.storeyExpressId, { ...base, Height: thickness });
  }
}

export function splitSlab(
  get: Get,
  api: StoreApi<ViewerState>,
  editorFor: (modelId: string) => StoreEditor | null,
  modelId: string,
  expressId: number,
  cutA: [number, number],
  cutB: [number, number],
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

  const added = addPiece(get, modelId, env, chain.elementType, cut, geo.thickness);
  if ('error' in added) return { ok: false as const, reason: added.error };

  const origin = chain.placementOrigin;
  const emitted = emitClippedProfile(env.editor, kept, origin, env.lengthUnitScale);
  const outline = { Profile: 'polygon' as const, Position: [0, 0, 0] as [number, number, number], OuterCurve: kept };
  const element: AuthoredElement = chain.elementType === 'IfcSpace'
    ? { kind: 'space', params: { ...outline, Height: geo.thickness } }
    : { kind: chain.elementType === 'IfcSlab' ? 'slab' : chain.elementType === 'IfcRoof' ? 'roof' : 'plate', params: { ...outline, Thickness: geo.thickness } };
  reshapeSource(get, api, modelId, expressId, [
    { entityId: chain.extrudedSolidId, index: 0, value: `#${emitted.profile}` },
    { entityId: chain.extrudedSolidId, index: 1, value: `#${emitted.solidPosition}` },
  ], sourceMesh(get, modelId, expressId, env, element));

  closeSplit(get, modelId, env, expressId, added.expressId);
  const [leftId, rightId] = keepFirst === leftIsFirst ? [expressId, added.expressId] : [added.expressId, expressId];
  return { ok: true as const, left: piece(get, modelId, leftId), right: piece(get, modelId, rightId) };
}
