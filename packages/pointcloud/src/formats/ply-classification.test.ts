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
  it('rejects invalid classes instead of wrapping them into another class', async () => {
    const blob = new Blob(['ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nproperty float classification\nend_header\n0 0 0 256\n']);
    const bytes=new Uint8Array(await blob.arrayBuffer());
    expect(()=>decodePly(bytes)).toThrow(/classification/);
    const reader=new PlyStreamingSource(blob);
    try { await reader.open(); await expect(reader.next(1)).rejects.toThrow(/classification/); }
    finally { reader.close(); }
  });
});
