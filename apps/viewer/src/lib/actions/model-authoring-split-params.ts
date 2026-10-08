/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ElementSplitRequest } from '@ifc-lite/create';
import type { AuthoringUnits } from './model-authoring';
import type { SplitSnapshot } from './model-authoring-split-state';
import { parseLength, record } from './model-authoring-fields';

export type SplitCut = ElementSplitRequest['cut'];

export function parseSplitSnapshot(value: unknown, at: string): SplitSnapshot {
  if (!record(value) || value.ok !== true || !['wall', 'linear', 'slab'].includes(String(value.kind))
    || !record(value.chain) || !record(value.placement) || !Number.isSafeInteger(value.storeyId)) {
    throw new Error(`${at}: provide the full canonical native split shape, placement and storey snapshot`);
  }
  if (Object.keys(value).some(key => !['ok', 'kind', 'chain', 'placement', 'storeyId'].includes(key))) throw new Error(`${at}: unsupported native split snapshot field`);
  if (value.kind === 'slab' && (!Array.isArray(value.chain.footprint) || value.chain.footprint.length < 3 || value.chain.footprint.length > 256
    || value.chain.footprint.some(point => !Array.isArray(point) || point.length !== 2 || point.some(v => typeof v !== 'number' || !Number.isFinite(v))))) {
    throw new Error(`${at}: provide 3–256 finite native footprint coordinate pairs`);
  }
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }]; let work = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    if (++work > 4096 || entry.depth > 12) throw new Error(`${at}: native split snapshot exceeds bounded work`);
    if (entry.value === null || typeof entry.value === 'boolean') continue;
    if (typeof entry.value === 'number' && Number.isFinite(entry.value)) continue;
    if (typeof entry.value === 'string' && entry.value.length <= 200) continue;
    if (Array.isArray(entry.value) || record(entry.value)) {
      for (const child of Object.values(entry.value)) stack.push({ value: child, depth: entry.depth + 1 });
    } else throw new Error(`${at}: native split snapshot contains unreadable values`);
  }
  return value as unknown as SplitSnapshot;
}

export function parseSplitCut(value: unknown, units: AuthoringUnits, at: string): SplitCut {
  if (!record(value)) throw new Error(`${at}: supply a native split cut`);
  if (value.kind === 'wall' || value.kind === 'linear') {
    if (Object.keys(value).some(key => !['kind', 'distance'].includes(key))) throw new Error(`${at}: unsupported native axis split field`);
    const distance = parseLength(value.distance, units, { min: 0, max: 10_000 }, `${at} distance`);
    if (!(distance > 0)) throw new Error(`${at}: distance must be positive`);
    return { kind: value.kind, distance };
  }
  if (value.kind !== 'slab' || Object.keys(value).some(key => !['kind', 'a', 'b'].includes(key))) throw new Error(`${at}: state a wall, linear or slab cut`);
  const point = (v: unknown, field: string): [number, number] => {
    if (!Array.isArray(v) || v.length !== 2) throw new Error(`${at} ${field}: state two storey-local coordinates`);
    return v.map((entry, index) => parseLength(entry, units, { min: -10_000, max: 10_000, signed: true }, `${at} ${field}[${index}]`)) as [number, number];
  };
  return { kind: 'slab', a: point(value.a, 'a'), b: point(value.b, 'b') };
}

export function splitCutInMetres(cut: SplitCut, units: AuthoringUnits): SplitCut {
  if (units === 'm') return cut;
  return cut.kind === 'slab' ? { kind: 'slab', a: [cut.a[0] / 1000, cut.a[1] / 1000], b: [cut.b[0] / 1000, cut.b[1] / 1000] }
    : { kind: cut.kind, distance: cut.distance / 1000 };
}
