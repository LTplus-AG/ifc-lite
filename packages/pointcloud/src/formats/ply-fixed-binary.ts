/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PlyPropertyDecl } from './ply.js';

interface FixedBinaryLayout {
  count: number;
  recordSize: number;
  properties: PlyPropertyDecl[];
}

export function decodeFixedBinaryPlyBody(
  view: DataView, vertex: FixedBinaryLayout, positions: Float32Array,
  colors: Float32Array | undefined, normals: Float32Array | undefined,
  intensities: Uint16Array | undefined, littleEndian: boolean,
  originOffset?: readonly [number, number, number],
): void {
  const offX = originOffset?.[0] ?? 0;
  const offY = originOffset?.[1] ?? 0;
  const offZ = originOffset?.[2] ?? 0;
  const find = (name: string) => vertex.properties.find((property) => property.name === name);
  const xProp = find('x')!;
  const yProp = find('y')!;
  const zProp = find('z')!;
  const rProp = colors ? find('red') ?? find('r') : undefined;
  const gProp = colors ? find('green') ?? find('g') : undefined;
  const bProp = colors ? find('blue') ?? find('b') : undefined;
  const nxProp = normals ? find('nx') : undefined;
  const nyProp = normals ? find('ny') : undefined;
  const nzProp = normals ? find('nz') : undefined;
  const iProp = intensities ? find('intensity') ?? find('scalar_Intensity') : undefined;

  for (let i = 0; i < vertex.count; i++) {
    const base = i * vertex.recordSize;
    positions[i * 3] = readScalar(view, base + xProp.offset, xProp.type, littleEndian) - offX;
    positions[i * 3 + 1] = readScalar(view, base + yProp.offset, yProp.type, littleEndian) - offY;
    positions[i * 3 + 2] = readScalar(view, base + zProp.offset, zProp.type, littleEndian) - offZ;
    if (colors && rProp && gProp && bProp) {
      colors[i * 3] = readScalar(view, base + rProp.offset, rProp.type, littleEndian);
      colors[i * 3 + 1] = readScalar(view, base + gProp.offset, gProp.type, littleEndian);
      colors[i * 3 + 2] = readScalar(view, base + bProp.offset, bProp.type, littleEndian);
    }
    if (normals && nxProp && nyProp && nzProp) {
      normals[i * 3] = readScalar(view, base + nxProp.offset, nxProp.type, littleEndian);
      normals[i * 3 + 1] = readScalar(view, base + nyProp.offset, nyProp.type, littleEndian);
      normals[i * 3 + 2] = readScalar(view, base + nzProp.offset, nzProp.type, littleEndian);
    }
    if (intensities && iProp) {
      intensities[i] = Math.min(65535, Math.max(0, readScalar(view, base + iProp.offset, iProp.type, littleEndian) | 0));
    }
  }
}

function readScalar(view: DataView, offset: number, type: string, littleEndian: boolean): number {
  switch (type) {
    case 'char': case 'int8': return view.getInt8(offset);
    case 'uchar': case 'uint8': return view.getUint8(offset);
    case 'short': case 'int16': return view.getInt16(offset, littleEndian);
    case 'ushort': case 'uint16': return view.getUint16(offset, littleEndian);
    case 'int': case 'int32': return view.getInt32(offset, littleEndian);
    case 'uint': case 'uint32': return view.getUint32(offset, littleEndian);
    case 'float': case 'float32': return view.getFloat32(offset, littleEndian);
    case 'double': case 'float64': return view.getFloat64(offset, littleEndian);
    default: throw new Error(`PLY: cannot read scalar of type "${type}"`);
  }
}
