/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { countObjVertices } from './obj.js';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('countObjVertices', () => {
  it('returns 0 for a header-only export (no visible mesh)', () => {
    const obj = encode('# ifc-lite OBJ export\n# units: metres (renderer Y-up frame, origin-folded world coords)\n');
    expect(countObjVertices(obj)).toBe(0);
  });

  it('counts "v " lines and ignores "vn "/"vt " lines', () => {
    const obj = encode(
      [
        '# ifc-lite OBJ export',
        'o IfcWall_1',
        'g IfcWall_1',
        'v 0.000000 0.000000 0.000000',
        'v 1.000000 0.000000 0.000000',
        'v 0.000000 1.000000 0.000000',
        'vn 0.000000 0.000000 1.000000',
        'vn 0.000000 0.000000 1.000000',
        'vn 0.000000 0.000000 1.000000',
        'vt 0.0 0.0',
        'f 1//1 2//2 3//3',
        '',
      ].join('\n'),
    );
    expect(countObjVertices(obj)).toBe(3);
  });

  it('returns 0 without throwing on an empty or non-UTF-8 buffer', () => {
    expect(countObjVertices(new Uint8Array(0))).toBe(0);
    expect(countObjVertices(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(0);
  });
});
