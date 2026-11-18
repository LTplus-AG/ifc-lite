/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { parseB3dm } from './b3dm.js';
import { buildB3dm, fixtureBytes, quadGlb } from '../../test/support.js';

describe('parseB3dm', () => {
  it('reads the recorded swisstopo leaf: header, RTC_CENTER, batch table columns', () => {
    const t = parseB3dm(fixtureBytes('swisstopo-20260520/11/668/1170.b3dm'));
    expect(t.version).toBe(1);
    expect(t.batchLength).toBe(4);
    expect(t.rtcCenter).toEqual([4324927.635372528, 564663.3368981095, 4638082.479673291]);
    expect(t.attributeNames).toContain('EGID');
    expect(t.row(2)?.UUID).toBe('9B6C1122-A443-4128-8B35-7171EA6BD829');
    expect(t.row(3)?.DACH_MAX).toBe(573.91);
    expect(t.glb.byteLength).toBeGreaterThan(0);
  });

  it('reads binary batch table columns and binary feature table semantics', () => {
    const ft = new Uint8Array(16);
    const ftv = new DataView(ft.buffer);
    ftv.setFloat32(0, 100.5, true);
    ftv.setFloat32(4, -200.25, true);
    ftv.setFloat32(8, 300, true);
    ftv.setUint32(12, 2, true);
    const bt = new Uint8Array(24);
    const btv = new DataView(bt.buffer);
    btv.setFloat64(0, 1.5, true);
    btv.setFloat64(8, -2.5, true);
    btv.setUint16(16, 7, true);
    btv.setUint16(18, 8, true);
    btv.setUint16(20, 9, true);
    btv.setUint16(22, 10, true);
    const t = parseB3dm(buildB3dm({
      featureTable: { BATCH_LENGTH: { byteOffset: 12 }, RTC_CENTER: { byteOffset: 0 } },
      featureBinary: ft,
      batchTable: {
        height: { byteOffset: 0, componentType: 'DOUBLE', type: 'SCALAR' },
        pair: { byteOffset: 16, componentType: 'UNSIGNED_SHORT', type: 'VEC2' },
        name: ['a', 'b'],
        extensions: { '3DTILES_batch_table_hierarchy': {} },
      },
      batchBinary: bt,
      glb: quadGlb(),
    }));
    expect(t.batchLength).toBe(2);
    expect(t.rtcCenter).toEqual([100.5, -200.25, 300]);
    expect([t.row(0), t.row(1)]).toEqual([{ height: 1.5, pair: [7, 8], name: 'a' }, { height: -2.5, pair: [9, 10], name: 'b' }]);
    expect(t.warnings).toEqual(['batch table extension 3DTILES_batch_table_hierarchy not read']);
  });

  it('detects the legacy 20- and 24-byte headers', () => {
    const glb = quadGlb();
    const json = new TextEncoder().encode('{"id":[5,6]}');
    // 20-byte: magic, version, byteLength, batchLength, batchTableByteLength.
    const h20 = new DataView(new ArrayBuffer(20));
    [0x62, 0x33, 0x64, 0x6d].forEach((c, i) => h20.setUint8(i, c));
    h20.setUint32(4, 1, true);
    h20.setUint32(8, 20 + json.byteLength + glb.byteLength, true);
    h20.setUint32(12, 2, true);
    h20.setUint32(16, json.byteLength, true);
    const legacy20 = new Uint8Array([...new Uint8Array(h20.buffer), ...json, ...glb]);
    const a = parseB3dm(legacy20);
    expect(a.batchLength).toBe(2);
    expect([a.row(0), a.row(1)]).toEqual([{ id: 5 }, { id: 6 }]);
    expect(a.warnings).toContain('legacy 20-byte b3dm header');

    // 24-byte: magic, version, byteLength, batchTableJsonByteLength, batchTableBinaryByteLength, batchLength.
    const h24 = new DataView(new ArrayBuffer(24));
    [0x62, 0x33, 0x64, 0x6d].forEach((c, i) => h24.setUint8(i, c));
    h24.setUint32(4, 1, true);
    h24.setUint32(8, 24 + json.byteLength + glb.byteLength, true);
    h24.setUint32(12, json.byteLength, true);
    h24.setUint32(16, 0, true);
    h24.setUint32(20, 2, true);
    const b = parseB3dm(new Uint8Array([...new Uint8Array(h24.buffer), ...json, ...glb]));
    expect(b.batchLength).toBe(2);
    expect(b.row(1)).toEqual({ id: 6 });
    expect(b.warnings).toContain('legacy 24-byte b3dm header');
  });

  it('rejects a truncated tile instead of reading past it', () => {
    const full = buildB3dm({ featureTable: { BATCH_LENGTH: 0 }, glb: quadGlb() });
    expect(() => parseB3dm(full.subarray(0, 40))).toThrow(/exceeds/);
  });
});
