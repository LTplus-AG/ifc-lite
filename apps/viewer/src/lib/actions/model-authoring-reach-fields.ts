/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ElementTrimExtendParams } from '@ifc-lite/create';
import { parseLength, record } from './model-authoring-fields';
import type { ElementTarget } from './model-authoring';

/** Expected is the verbatim complete native reader snapshot, including source IDs and mixed native units.
 * It is a comparison pin, never a writer input. Click/boundary lengths use batch units. */
export interface ReachFields {
  mode: 'trim' | 'extend';
  expected: { kind: 'wall' | 'beam'; snapshot: Record<string, unknown> };
  click: [number, number];
  boundary: { line: Exclude<ElementTrimExtendParams['boundary'], { wallId: number }> }
    | { wall: ElementTarget; expected?: Record<string, unknown> };
}

/** JSON-only, bounded native pin. No field, ID or mixed-unit source coordinate is reinterpreted. */
export function nativeReachPin(value: unknown, at: string): Record<string, unknown> {
  let work = 0;
  function walk(item: unknown, depth: number): unknown {
    if (++work > 512 || depth > 8) throw new Error(`${at} exceeds the native snapshot bound`);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string' && item.length <= 200) return item;
    if (Array.isArray(item)) return item.map(child => walk(child, depth + 1));
    if (record(item)) return Object.fromEntries(Object.entries(item).map(([key, child]) => {
      if (key.length > 200) throw new Error(`${at} key exceeds the native snapshot bound`);
      return [key, walk(child, depth + 1)];
    }));
    throw new Error(`${at} must be a finite native JSON snapshot`);
  }
  if (!record(value)) throw new Error(`${at} must be the complete native reader object`);
  return walk(value, 0) as Record<string, unknown>;
}

export function parseReachFields(value: Record<string, unknown>, units: 'm' | 'mm', at: string,
  target: (value: unknown, at: string) => ElementTarget): ReachFields {
  if (value.mode !== 'trim' && value.mode !== 'extend') throw new Error(`${at} mode must be trim or extend`);
  const expected = value.expected;
  if (!record(expected) || (expected.kind !== 'wall' && expected.kind !== 'beam')) throw new Error(`${at} needs expected kind wall or beam`);
  const snapshot = nativeReachPin(expected.kind === 'wall' ? expected.wall : expected.chain, `${at} expected`);
  const length = (v: unknown, name: string) => parseLength(v, units, { min: -10_000, max: 10_000, signed: true }, name);
  const point = (v: unknown, name: string): [number, number] => {
    if (!Array.isArray(v) || v.length !== 2) throw new Error(`${name} must be [x,y] in ${units}`);
    return [length(v[0], name), length(v[1], name)];
  };
  const boundary = value.boundary;
  if (!record(boundary) || ('line' in boundary) === ('wall' in boundary)) throw new Error(`${at} boundary must name exactly one line or wall`);
  let parsed: ReachFields['boundary'];
  if ('line' in boundary) {
    const line = boundary.line;
    if (!record(line) || typeof line.tMin !== 'number' || !Number.isFinite(line.tMin)
      || typeof line.tMax !== 'number' || !Number.isFinite(line.tMax) || line.tMin > line.tMax) throw new Error(`${at} boundary line needs finite ordered tMin/tMax`);
    parsed = { line: { a: point(line.a, `${at} boundary a`), b: point(line.b, `${at} boundary b`),
      tMin: line.tMin, tMax: line.tMax, reach: parseLength(line.reach, units, { min: 0, max: 10 }, `${at} boundary reach`) } };
  } else {
    const wall = target(boundary.wall, `${at} boundary wall`);
    if (!('ref' in wall) && !wall.ifcClass.startsWith('IfcWall')) throw new Error(`${at} boundary must be an IfcWall`);
    parsed = { wall, ...('ref' in wall ? {} : { expected: nativeReachPin(boundary.expected, `${at} boundary expected`) }) };
  }
  return { mode: value.mode, expected: { kind: expected.kind, snapshot }, click: point(value.click, `${at} click`), boundary: parsed };
}

export function sameReachPin(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'number' && typeof expected === 'number') return Math.abs(actual - expected) <= 1e-9;
  if (Array.isArray(actual) || Array.isArray(expected)) return Array.isArray(actual) && Array.isArray(expected)
    && actual.length === expected.length && actual.every((item, index) => sameReachPin(item, expected[index]));
  if (record(actual) && record(expected)) return Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(actual).every(([key, item]) => Object.hasOwn(expected, key) && sameReachPin(item, expected[key]));
  return actual === expected;
}
