/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it, expect } from 'vitest';
import { decodePly } from './ply.js';
import { PlyStreamingSource } from '../streaming/ply-source.js';

// Positioned scan downloads must retain LAS classes on first and subsequent reloads.
describe('PLY classification round-trip', () => {
  for (const format of ['ascii', 'binary_little_endian', 'binary_big_endian']) for (const variable of [false,true]) {
    it(`${format}, ${variable ? 'list' : 'fixed'} rows retains all 8 class bits`, async () => {
      const header = `ply\nformat ${format} 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\n${variable ? 'property list uchar float ignored\n' : ''}property uchar classification\nend_header\n`;
      const binary = new ArrayBuffer((variable ? 14 : 13)*2); const data = new DataView(binary);
      for (let row=0;row<2;row++) {
        const offset = row*(variable ? 14 : 13);
        data.setFloat32(offset,row+1,format==='binary_little_endian');
        data.setUint8(offset+(variable ? 13 : 12), row ? 255 : 42);
      }
      const blob = new Blob([header,format==='ascii' ? `1 0 0 ${variable ? '0 ' : ''}42\n2 0 0 ${variable ? '0 ' : ''}255\n` : binary]);
      expect([...decodePly(new Uint8Array(await blob.arrayBuffer())).classifications!]).toEqual([42,255]);
      const reader=new PlyStreamingSource(blob);
      try {
        expect((await reader.open()).hasClassification).toBe(true);
        expect([...(await reader.next(1))!.classifications!]).toEqual([42]);
        expect([...(await reader.next(1))!.classifications!]).toEqual([255]);
      } finally { reader.close(); }
    });
  }
  // #8915: optional metadata must not turn previously loadable geometry into a decode error.
  for (const format of ['ascii', 'binary_little_endian', 'binary_big_endian']) {
    for (const value of [3.5, 256, -1, Number.NaN, 'list', 'duplicate'] as const) {
      it(`${format} ignores unsupported classification ${value} without losing geometry or following attributes`, async () => {
        const declaration = value === 'list' ? 'property list uchar float classification'
          : value === 'duplicate' ? 'property uchar classification\nproperty uchar classification'
          : 'property float classification';
        const header = `ply\nformat ${format} 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\n${declaration}\nproperty ushort intensity\nend_header\n`;
        const size = value === 'list' ? 5 : value === 'duplicate' ? 2 : 4;
        const binary = new ArrayBuffer(12 + size + 2);
        const data = new DataView(binary), le = format === 'binary_little_endian';
        [1, 2, 3].forEach((coordinate, i) => data.setFloat32(i * 4, coordinate, le));
        if (value === 'list') { data.setUint8(12, 1); data.setFloat32(13, 3.5, le); }
        else if (value === 'duplicate') { data.setUint8(12, 42); data.setUint8(13, 43); }
        else data.setFloat32(12, value, le);
        data.setUint16(12 + size, 81, le);
        const column = value === 'list' ? '1 3.5' : value === 'duplicate' ? '42 43' : String(value);
        const blob = new Blob([header, format === 'ascii' ? `1 2 3 ${column} 81\n` : binary]);
        const decoded = decodePly(new Uint8Array(await blob.arrayBuffer()));
        expect([...decoded.positions]).toEqual([1, 2, 3]);
        expect([...decoded.intensities!]).toEqual([81]);
        expect(decoded.classifications).toBeUndefined();
        const reader = new PlyStreamingSource(blob);
        try {
          expect((await reader.open()).hasClassification).toBe(false);
          const chunk = (await reader.next(1))!;
          expect([...chunk.positions]).toEqual([1, 2, 3]);
          expect([...chunk.intensities!]).toEqual([81]);
          expect(chunk.classifications).toBeUndefined();
        } finally { reader.close(); }
      });
    }
  }
  for (const variable of [false, true]) {
    it(`#8915 malformed ASCII byte classes stay loadable (${variable ? 'variable' : 'fixed'} rows)`, async () => {
      const values = [42, 300, -1, 3.5, NaN, Infinity, 255];
      const header = `ply\nformat ascii 1.0\nelement vertex ${values.length}\nproperty float x\nproperty float y\nproperty float z\n${variable ? 'property list uchar float ignored\n' : ''}property uchar classification\nproperty ushort intensity\nend_header\n`;
      const blob = new Blob([header, values.map((value, i) => `${i} 2 3 ${variable ? '1 9 ' : ''}${value} 81`).join('\n')]);
      const decoded = decodePly(new Uint8Array(await blob.arrayBuffer()));
      expect([...decoded.classifications!]).toEqual([42, 0, 0, 0, 0, 0, 255]);
      expect([...decoded.positions]).toEqual(values.flatMap((_, i) => [i, 2, 3]));
      expect([...decoded.intensities!]).toEqual(values.map(() => 81));
      const reader = new PlyStreamingSource(blob);
      try {
        await reader.open();
        const chunks = [];
        for (;;) { const chunk = await reader.next(2); if (!chunk) break; chunks.push(chunk); }
        expect(chunks.flatMap(chunk => [...chunk.classifications!])).toEqual([...decoded.classifications!]);
        expect(chunks.flatMap(chunk => [...chunk.positions])).toEqual([...decoded.positions]);
        expect(chunks.flatMap(chunk => [...chunk.intensities!])).toEqual([...decoded.intensities!]);
      } finally { reader.close(); }
    });
  }

});
