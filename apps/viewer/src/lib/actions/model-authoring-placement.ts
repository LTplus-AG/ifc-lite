/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readElementTransformPlacement } from '@/lib/element-transform/plan';
import { AnchorEntityReader } from '../../../../../packages/create/src/in-store/resolve-anchor';
import { placementInAncestor, type Frame3 } from '../../../../../packages/create/src/in-store/host-geometry-frame';
import { objectPlacementOf } from '../../../../../packages/create/src/in-store/element-transform-frames';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { effectiveStoreyId } from '../../../../../packages/create/src/in-store/edit/effective-storey';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import { nativeLengthUnitAvailable } from './model-authoring-read-target';
import { placementAngle } from './model-authoring-read';

/** Canonical planner fields, flattened for bounded evidence. All origins are SI
 * storey-local metres; axes/degrees and model-local EXPRESS ids are not lengths. */
export interface PlanarNativePlacement {
  units: 'm'; expressId: number; storeyId: number;
  origin: [number, number]; parentOrigin: [number, number]; parentAxis: [number, number];
  upright: boolean; angleDeg: number | null;
}
export interface SpatialNativePlacement {
  units: 'm'; expressId: number; storeyId: number; layout: 'spatial'; placementId: number; frame: Frame3;
}
export type NativePlacement = PlanarNativePlacement | SpatialNativePlacement;
export function nativePlacementFromTarget(target: ModelEditTarget | null, expressId: number): NativePlacement | null {
  if (!target || !nativeLengthUnitAvailable(target)) return null;
  const storeyId = effectiveStoreyId(target.dataStore, target.view, expressId) ?? null;
  const root = readElementTransformPlacement(target, expressId, storeyId);
  if ('reason' in root) {
    if (storeyId === null) return null;
    const placementId = objectPlacementOf(target, expressId), ancestorId = objectPlacementOf(target, storeyId);
    if (placementId === null || ancestorId === null) return null;
    const frame = placementInAncestor(new AnchorEntityReader(target.dataStore, target.view), placementId, ancestorId);
    if (!frame) return null;
    const scale = getModelLengthUnitScale(target.dataStore);
    return { units: 'm', expressId, storeyId, layout: 'spatial', placementId,
      frame: { ...frame, o: [frame.o[0] * scale, frame.o[1] * scale, frame.o[2] * scale] } };
  }
  const angle = placementAngle(target, expressId);
  return { units: 'm', expressId, storeyId: root.storeyId, origin: [...root.origin],
    parentOrigin: [...root.parent.origin], parentAxis: [...root.parent.axis], upright: root.upright,
    angleDeg: angle?.turnable ? angle.deg + Math.atan2(root.parent.axis[1], root.parent.axis[0]) * 180 / Math.PI : null };
}
export function parseNativePlacement(value: unknown, at: string): NativePlacement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at}: copy the complete nativePlacement snapshot`);
  const r = value as Record<string, unknown>;
  const id = (key: string) => { const n = r[key]; if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw new Error(`${at}: invalid native ${key}`); return n; };
  const pair = (key: string): [number, number] => {
    const p = r[key]; if (!Array.isArray(p) || p.length !== 2 || !p.every(v => typeof v === 'number' && Number.isFinite(v))) throw new Error(`${at}: invalid native ${key}`);
    return [p[0], p[1]];
  };
  if (r.units !== 'm') throw new Error(`${at}: unknown native placement units`);
  if (r.layout === 'spatial') {
    if (!r.frame || typeof r.frame !== 'object' || Array.isArray(r.frame)) throw new Error(`${at}: incomplete native spatial frame`);
    const frame = r.frame as Record<string, unknown>;
    const triple = (key: string): [number, number, number] => {
      const p = frame[key];
      if (!Array.isArray(p) || p.length !== 3 || !p.every(v => typeof v === 'number' && Number.isFinite(v))) throw new Error(`${at}: invalid native spatial ${key}`);
      return [p[0], p[1], p[2]];
    };
    return { units: 'm', expressId: id('expressId'), storeyId: id('storeyId'), layout: 'spatial', placementId: id('placementId'),
      frame: { o: triple('o'), x: triple('x'), y: triple('y'), z: triple('z') } };
  }
  if (r.units !== 'm' || typeof r.upright !== 'boolean' || (r.angleDeg !== null && (typeof r.angleDeg !== 'number' || !Number.isFinite(r.angleDeg)))) throw new Error(`${at}: incomplete native placement units/orientation`);
  return { units: 'm', expressId: id('expressId'), storeyId: id('storeyId'), origin: pair('origin'),
    parentOrigin: pair('parentOrigin'), parentAxis: pair('parentAxis'), upright: r.upright, angleDeg: r.angleDeg as number | null };
}
export const sameNativePlacement = (a: NativePlacement | null, b: NativePlacement) => !!a && JSON.stringify(a) === JSON.stringify(b);
