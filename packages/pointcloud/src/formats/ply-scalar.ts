/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

interface ScalarProperty { type: string }

export function readPlyScalar(
  view: DataView,
  offset: number,
  prop: ScalarProperty,
  littleEndian: boolean,
): number {
  switch (prop.type) {
    case 'char':
    case 'int8': return view.getInt8(offset);
    case 'uchar':
    case 'uint8': return view.getUint8(offset);
    case 'short':
    case 'int16': return view.getInt16(offset, littleEndian);
    case 'ushort':
    case 'uint16': return view.getUint16(offset, littleEndian);
    case 'int':
    case 'int32': return view.getInt32(offset, littleEndian);
    case 'uint':
    case 'uint32': return view.getUint32(offset, littleEndian);
    case 'float':
    case 'float32': return view.getFloat32(offset, littleEndian);
    case 'double':
    case 'float64': return view.getFloat64(offset, littleEndian);
    default: throw new Error(`PLY: cannot read scalar of type "${prop.type}"`);
  }
}
