/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ElementSizePatch } from '@/store/slices/mutation-element-size';
import { parseLength, record } from './model-authoring-fields';
import type { AuthoringUnits } from './model-authoring';

export type ExpectedSize =
  | { kind: 'wall'; height: number; thickness: number }
  | { kind: 'slab'; thickness: number }
  | { kind: 'linear'; length: number; width: number; cross: number; profiled: boolean };

const ranges = {
  height: { min: .1, max: 200 }, thickness: { min: .01, max: 5 }, length: { min: .05, max: 1000 },
  width: { min: .000001, max: 10 }, cross: { min: .000001, max: 10 },
};

/** Bounded declared-unit contract; the native size editor decides authorability. */
export function parseSizeParams(value: unknown, units: AuthoringUnits, at: string, expected: true): ExpectedSize;
export function parseSizeParams(value: unknown, units: AuthoringUnits, at: string, expected: false): ElementSizePatch;
export function parseSizeParams(value: unknown, units: AuthoringUnits, at: string, expected: boolean): ExpectedSize | ElementSizePatch {
  if (!record(value) || !['wall', 'slab', 'linear'].includes(String(value.kind))) throw new Error(`${at}: state the native size kind wall, slab or linear`);
  const names = value.kind === 'wall' ? ['height', 'thickness'] : value.kind === 'slab' ? ['thickness'] : ['length', 'width', 'cross'];
  const extra = value.kind === 'linear' ? expected ? ['profiled'] : ['fixed'] : [];
  for (const name of Object.keys(value)) if (name !== 'kind' && !names.includes(name) && !extra.includes(name)) throw new Error(`${at}: unsupported native size field ${name}`);
  const result: Record<string, string | number | boolean> = { kind: String(value.kind) };
  for (const name of names) {
    if (!expected && value[name] === undefined) continue;
    // Expected fields describe existing native geometry; creation/proposal
    // minima would reject a valid small source element before comparison.
    const length = parseLength(value[name], units, expected ? { min: 0, max: Number.MAX_VALUE }
      : ranges[name as keyof typeof ranges], `${at} ${name}`);
    if (expected && !(units === 'mm' ? length / 1000 > 0 : length > 0)) throw new Error(`${at} ${name} must describe a positive native dimension`);
    result[name] = length;
  }
  if (!expected && !names.some(name => value[name] !== undefined)) throw new Error(`${at}: state at least one changed dimension`);
  if (value.kind === 'linear' && expected) {
    if (typeof value.profiled !== 'boolean') throw new Error(`${at}: expected native linear size must state profiled`);
    result.profiled = value.profiled;
  }
  if (value.fixed !== undefined) {
    if (value.fixed !== 'start' && value.fixed !== 'end') throw new Error(`${at}: fixed must be start or end`);
    if (value.length === undefined) throw new Error(`${at}: fixed needs a changed length`);
    result.fixed = value.fixed;
  }
  return result as unknown as ExpectedSize | ElementSizePatch;
}

export function sizeInMetres<T extends ExpectedSize | ElementSizePatch>(size: T, units: AuthoringUnits): T {
  return Object.fromEntries(Object.entries(size).map(([key, value]) => [key, typeof value === 'number' && units === 'mm' ? value / 1000 : value])) as T;
}
