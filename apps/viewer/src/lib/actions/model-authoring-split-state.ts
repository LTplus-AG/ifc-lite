/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { resolveSplitTarget, type SplitTarget } from '@/lib/split-target';
import { effectiveStoreyId } from '@/lib/effective-storey';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { readSplitPlacement } from '../../../../../packages/create/src/in-store/element-split-placement';
import type { AuthoringUnits } from './model-authoring';
import { record } from './model-authoring-fields';

export type SplitSnapshot = Extract<SplitTarget, { ok: true }> & {
  placement: ReturnType<typeof readSplitPlacement>;
  storeyId: number;
};

const LENGTH_FIELDS = new Set(['startCoordinates', 'wallLength', 'thickness', 'height', 'depth', 'profileWidth', 'profileHeight', 'placementOrigin', 'baseElevation', 'footprint']);
function scaled(value: unknown, factor: number): unknown {
  return Array.isArray(value) ? value.map(entry => scaled(entry, factor)) : typeof value === 'number' ? value * factor : value;
}

/** Full existing native shape and placement, with only dimension fields
 * converted to declared units. IDs, direction vectors and native scale stay
 * unchanged. No geometry is inferred here. */
export function readSplitSnapshot(store: IfcDataStore, editor: StoreEditor, id: number, units: AuthoringUnits): SplitSnapshot {
  const view = editor.getMutationView(), scale = getModelLengthUnitScale(store);
  const target = resolveSplitTarget(store, view, editor, id, scale);
  if (!target.ok) throw new Error(`Split unavailable: ${target.code}`);
  if (target.kind === 'slab' && target.chain.footprint.length > 256) throw new Error('Split preview exceeds 256 footprint vertices; no vertices are discarded');
  const storeyId = effectiveStoreyId(store, view, id);
  if (storeyId === undefined) throw new Error('Split requires a live storey');
  // This existing reader takes the writer's environment; these are all real
  // current fields. It reads only the effective source placement, not GUIDs.
  const placement = readSplitPlacement({ dataStore: store, view, editor, storeyExpressId: storeyId,
    lengthUnitScale: scale, newGlobalId: store.entities.getGlobalId(id), name: store.entities.getName(id) }, id);
  const factor = units === 'mm' ? 1000 : 1;
  const chain = Object.fromEntries(Object.entries(target.chain).map(([key, value]) => [key,
    LENGTH_FIELDS.has(key) ? scaled(value, factor) : key === 'profile' && record(value)
      ? Object.fromEntries(Object.entries(value).map(([field, entry]) => [field, field === 'Type' ? entry : scaled(entry, factor)])) : value]));
  return { ...target, chain, storeyId, placement: { ...placement, frame: { ...placement.frame,
    o: placement.frame.o.map(value => value * scale * factor) as [number, number, number] } } } as SplitSnapshot;
}

/** Bounded structural comparison: expected snapshots are contract data, not
 * a second source resolver. Provenance integers/directions compare exactly;
 * serialized finite geometry values retain their full native precision. */
export function sameSplitSnapshot(a: unknown, b: unknown): boolean {
  const stack: [unknown, unknown][] = [[a, b]];
  let work = 0;
  while (stack.length) {
    if (++work > 4096) return false;
    const [left, right] = stack.pop()!;
    if (left === right) continue;
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length !== right.length) return false;
      left.forEach((entry, index) => stack.push([entry, right[index]]));
    } else if (record(left) && record(right)) {
      const keys = Object.keys(left);
      if (keys.length !== Object.keys(right).length || keys.some(key => !Object.hasOwn(right, key))) return false;
      for (const key of keys) stack.push([left[key], right[key]]);
    } else return false;
  }
  return true;
}
