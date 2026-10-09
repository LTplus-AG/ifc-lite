/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { planElementTransform } from '@/lib/element-transform/plan';
import { effectiveStoreyId } from '../../../../../packages/create/src/in-store/edit/effective-storey';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import { nativeLengthUnitAvailable } from './model-authoring-read-target';
import { placementAngle } from './model-authoring-read';

/** Canonical planner fields, flattened for bounded evidence. All origins are SI
 * storey-local metres; axes/degrees and model-local EXPRESS ids are not lengths. */
export interface NativePlacement {
  units: 'm'; expressId: number; storeyId: number;
  origin: [number, number]; parentOrigin: [number, number]; parentAxis: [number, number];
  upright: boolean; angleDeg: number | null;
}
export function nativePlacementFromTarget(target: ModelEditTarget | null, expressId: number): NativePlacement | null {
  if (!target || !nativeLengthUnitAvailable(target)) return null;
  const plan = planElementTransform({ ...target, selected: [expressId],
    storeyOf: id => effectiveStoreyId(target.dataStore, target.view, id) ?? null });
  const root = plan.roots.find(row => row.expressId === expressId);
  const angle = placementAngle(target, expressId);
  if (plan.refused.length || !root) return null;
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
  if (r.units !== 'm' || typeof r.upright !== 'boolean' || (r.angleDeg !== null && (typeof r.angleDeg !== 'number' || !Number.isFinite(r.angleDeg)))) throw new Error(`${at}: incomplete native placement units/orientation`);
  return { units: 'm', expressId: id('expressId'), storeyId: id('storeyId'), origin: pair('origin'),
    parentOrigin: pair('parentOrigin'), parentAxis: pair('parentAxis'), upright: r.upright, angleDeg: r.angleDeg as number | null };
}
export const sameNativePlacement = (a: NativePlacement | null, b: NativePlacement) => !!a && JSON.stringify(a) === JSON.stringify(b);
