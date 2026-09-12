/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PlyPropertyOrderEntry } from './ply.js';
import { readPlyScalar } from './ply-scalar.js';

export function parseAsciiVariableRow(tokens: readonly string[], order: readonly PlyPropertyOrderEntry[], row: number): Map<string, number> {
  const values = new Map<string, number>();
  let cursor = 0;
  for (const entry of order) {
    if (entry.kind === 'scalar') {
      if (cursor >= tokens.length) throw new Error(`PLY ascii: vertex row ${row + 1} is missing property ${entry.property.name}`);
      values.set(entry.property.name, Number(tokens[cursor++]));
      continue;
    }
    const count = Number(tokens[cursor++]);
    if (!Number.isSafeInteger(count) || count < 0 || cursor + count > tokens.length) throw new Error(`PLY ascii: vertex row ${row + 1} has an invalid ${entry.name} list`);
    cursor += count;
  }
  if (cursor !== tokens.length) throw new Error(`PLY ascii: vertex row ${row + 1} has unexpected trailing values`);
  return values;
}

export function parseBinaryVariableRow(view: DataView, start: number, order: readonly PlyPropertyOrderEntry[], littleEndian: boolean, row: number): { values: Map<string, number>; end: number } {
  const values = new Map<string, number>();
  let cursor = start;
  for (const entry of order) {
    if (entry.kind === 'scalar') {
      if (cursor + entry.property.size > view.byteLength) throw new Error(`PLY binary: vertex row ${row + 1} is truncated`);
      values.set(entry.property.name, readPlyScalar(view, cursor, entry.property, littleEndian));
      cursor += entry.property.size;
      continue;
    }
    if (cursor + entry.countSize > view.byteLength) throw new Error(`PLY binary: vertex row ${row + 1} list count is truncated`);
    const count = readPlyScalar(view, cursor, { type: entry.countType }, littleEndian);
    cursor += entry.countSize;
    const bytes = count * entry.itemSize;
    if (!Number.isSafeInteger(count) || count < 0 || cursor + bytes > view.byteLength) throw new Error(`PLY binary: vertex row ${row + 1} has an invalid ${entry.name} list`);
    cursor += bytes;
  }
  return { values, end: cursor };
}

export interface VariablePlyOutputs {
  positions: Float32Array; colors?: Float32Array; normals?: Float32Array; intensities?: Uint16Array;
  originOffset?: readonly [number, number, number];
}

export function writeVariablePlyRow(values: ReadonlyMap<string, number>, row: number, output: VariablePlyOutputs): void {
  const origin = output.originOffset ?? [0, 0, 0];
  output.positions[row * 3] = (values.get('x') ?? Number.NaN) - origin[0];
  output.positions[row * 3 + 1] = (values.get('y') ?? Number.NaN) - origin[1];
  output.positions[row * 3 + 2] = (values.get('z') ?? Number.NaN) - origin[2];
  if (output.colors) {
    output.colors[row * 3] = values.get('red') ?? values.get('r') ?? Number.NaN;
    output.colors[row * 3 + 1] = values.get('green') ?? values.get('g') ?? Number.NaN;
    output.colors[row * 3 + 2] = values.get('blue') ?? values.get('b') ?? Number.NaN;
  }
  if (output.normals) {
    output.normals[row * 3] = values.get('nx') ?? Number.NaN;
    output.normals[row * 3 + 1] = values.get('ny') ?? Number.NaN;
    output.normals[row * 3 + 2] = values.get('nz') ?? Number.NaN;
  }
  if (output.intensities) {
    const value = values.get('intensity') ?? values.get('scalar_Intensity') ?? 0;
    output.intensities[row] = Math.min(65535, Math.max(0, value | 0));
  }
}
