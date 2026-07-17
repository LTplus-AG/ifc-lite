/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePcd } from './pcd.js';

// Vitest currently injects `__dirname` even in ESM packages, but a fresh
// node-runner will not. Resolve the repo root via `import.meta.url` so the
// fixture-loading tests don't break when this is run outside vitest.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');

// Fixtures live in a GitHub Release (AGENTS.md §9). Skip the IFCx-fixture
// suite cleanly when they're absent so a fresh checkout — or any CI job
// that hasn't run `pnpm fixtures` yet — doesn't crash with ENOENT.
const SMALL_PCD = path.join(REPO_ROOT, 'tests/models/ifc5/Point_Cloud_point-cloud.ifcx');
const LARGE_PCD = path.join(REPO_ROOT, 'tests/models/ifc5/Point_Cloud_S1-pointcloud.ifcx');
const FIXTURES_AVAILABLE = existsSync(SMALL_PCD) && existsSync(LARGE_PCD);

function buildAsciiPcd(rows: number[][], rgbColumn = false): Uint8Array {
  const fields = rgbColumn ? 'x y z rgb' : 'x y z';
  const sizes = rgbColumn ? '4 4 4 4' : '4 4 4';
  const types = rgbColumn ? 'F F F U' : 'F F F';
  const counts = rgbColumn ? '1 1 1 1' : '1 1 1';
  const header = [
    `# .PCD test`,
    `VERSION 0.7`,
    `FIELDS ${fields}`,
    `SIZE ${sizes}`,
    `TYPE ${types}`,
    `COUNT ${counts}`,
    `WIDTH ${rows.length}`,
    `HEIGHT 1`,
    `VIEWPOINT 0 0 0 1 0 0 0`,
    `POINTS ${rows.length}`,
    `DATA ascii`,
    '',
  ].join('\n');
  const body = rows.map((r) => r.join(' ')).join('\n') + '\n';
  return new TextEncoder().encode(header + body);
}

describe('decodePcd ASCII', () => {
  it('decodes a tiny xyz-only point cloud', () => {
    const buf = buildAsciiPcd([
      [1, 2, 3],
      [-4, -5, -6],
      [0, 0, 0],
    ]);
    const chunk = decodePcd(buf);
    expect(chunk.pointCount).toBe(3);
    expect(Array.from(chunk.positions)).toEqual([1, 2, 3, -4, -5, -6, 0, 0, 0]);
    expect(chunk.colors).toBeUndefined();
    expect(chunk.bbox).toEqual({ min: [-4, -5, -6], max: [1, 2, 3] });
  });

  it('decodes RGB packed as a uint32 column (TYPE U)', () => {
    // 0x00FF0000 = pure red, 0x0000FF00 = pure green, 0x000000FF = pure blue
    const buf = buildAsciiPcd([
      [1, 0, 0, 0x00ff0000],
      [0, 1, 0, 0x0000ff00],
      [0, 0, 1, 0x000000ff],
    ], true);
    const chunk = decodePcd(buf);
    expect(chunk.colors).toBeDefined();
    const c = chunk.colors!;
    expect(c[0]).toBe(1); expect(c[1]).toBe(0); expect(c[2]).toBe(0);
    expect(c[3]).toBe(0); expect(c[4]).toBe(1); expect(c[5]).toBe(0);
    expect(c[6]).toBe(0); expect(c[7]).toBe(0); expect(c[8]).toBe(1);
  });
});

describe('decodePcd binary', () => {
  it('round-trips three points', () => {
    // Build a binary PCD by hand: header + 3 * 12 bytes of LE float32
    const header = new TextEncoder().encode([
      `# .PCD test`,
      `VERSION 0.7`,
      `FIELDS x y z`,
      `SIZE 4 4 4`,
      `TYPE F F F`,
      `COUNT 1 1 1`,
      `WIDTH 3`,
      `HEIGHT 1`,
      `VIEWPOINT 0 0 0 1 0 0 0`,
      `POINTS 3`,
      `DATA binary`,
      '',
    ].join('\n'));
    const body = new ArrayBuffer(3 * 12);
    const view = new DataView(body);
    const values = [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 100, 200, 300];
    for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i], true);
    const merged = new Uint8Array(header.length + body.byteLength);
    merged.set(header, 0);
    merged.set(new Uint8Array(body), header.length);
    const chunk = decodePcd(merged);
    expect(chunk.pointCount).toBe(3);
    expect(Array.from(chunk.positions)).toEqual(values);
  });
});

describe('decodePcd pre-allocation guard', () => {
  const hugeHeader = (dataKind: string) =>
    new TextEncoder().encode(
      [
        `VERSION 0.7`,
        `FIELDS x y z`,
        `SIZE 4 4 4`,
        `TYPE F F F`,
        `COUNT 1 1 1`,
        `WIDTH 1000000000`,
        `HEIGHT 1`,
        `POINTS 1000000000`,
        `DATA ${dataKind}`,
        '',
      ].join('\n'),
    );

  it('rejects a huge POINTS count with a tiny binary body (no OOM alloc)', () => {
    const header = hugeHeader('binary');
    const buf = new Uint8Array(header.length + 12); // room for one point only
    buf.set(header, 0);
    expect(() => decodePcd(buf)).toThrow(/body bytes|available/i);
  });

  it('rejects a huge POINTS count in an ascii body', () => {
    const header = hugeHeader('ascii');
    const buf = new Uint8Array(header.length + 8);
    buf.set(header, 0);
    buf.set(new TextEncoder().encode('1 2 3\n'), header.length);
    expect(() => decodePcd(buf)).toThrow(/body bytes|available/i);
  });

  const compressedPcd = (points: number, compressedBody: Uint8Array): Uint8Array => {
    const header = new TextEncoder().encode(
      [
        `VERSION 0.7`,
        `FIELDS x y z`,
        `SIZE 4 4 4`,
        `TYPE F F F`,
        `COUNT 1 1 1`,
        `WIDTH ${points}`,
        `HEIGHT 1`,
        `POINTS ${points}`,
        `DATA binary_compressed`,
        '',
      ].join('\n'),
    );
    const sizes = new Uint8Array(8);
    const dv = new DataView(sizes.buffer);
    dv.setUint32(0, compressedBody.length, true);
    dv.setUint32(4, points * 12, true); // uncompressedSize = points * stride
    const buf = new Uint8Array(header.length + 8 + compressedBody.length);
    buf.set(header, 0);
    buf.set(sizes, header.length);
    buf.set(compressedBody, header.length + 8);
    return buf;
  };

  it('rejects binary_compressed declaring a huge uncompressed size from a tiny blob', () => {
    // POINTS * stride(12) == declared uncompressedSize so the existing equality
    // check passes and we reach the MAX_LZF_RATIO guard: 960MB uncompressed
    // bytes (under the absolute ceiling) claimed from a 4-byte compressed body.
    const buf = compressedPcd(80_000_000, new Uint8Array(4));
    expect(() => decodePcd(buf)).toThrow(/exceeds .* compressed body/i);
  });

  it('rejects binary_compressed over the absolute uncompressed ceiling', () => {
    // 1.2e9 declared bytes trip the 1 GiB ceiling regardless of how large the
    // compressed body claims to be.
    const buf = compressedPcd(100_000_000, new Uint8Array(4));
    expect(() => decodePcd(buf)).toThrow(/decode ceiling/i);
  });

  it('accepts genuinely repetitive LZF between 64x and 88x expansion', () => {
    // LZF's extended back-reference emits up to 264 output bytes per 3 input
    // bytes (~88x), so highly repetitive but VALID streams can exceed the old
    // 64x bound. Hand-built stream (no encoder in this repo — lzf.ts is
    // decode-only): 8 input bytes -> 528 zero bytes = 44 points * stride 12.
    //   [0x00 0x00]      literal run of 1 zero byte
    //   [0xE0 0xFF 0x00] back-ref len 7+255+2 = 264 at offset 1 (overlapping)
    //   [0xE0 0xFE 0x00] back-ref len 7+254+2 = 263
    const stream = new Uint8Array([0x00, 0x00, 0xe0, 0xff, 0x00, 0xe0, 0xfe, 0x00]);
    const buf = compressedPcd(44, stream);
    // 528 > 8 * 64: the previous MAX_LZF_RATIO=64 rejected this valid file.
    expect(528).toBeGreaterThan(stream.length * 64);
    const chunk = decodePcd(buf);
    expect(chunk.pointCount).toBe(44);
    expect(chunk.positions.length).toBe(44 * 3);
    expect(chunk.positions.every((v) => v === 0)).toBe(true);
  });

  it('ascii body at the minimum byte floor passes (EOF-terminated); truncated fails', () => {
    const header = (points: number) =>
      [
        `VERSION 0.7`,
        `FIELDS x y z`,
        `SIZE 4 4 4`,
        `TYPE F F F`,
        `COUNT 1 1 1`,
        `WIDTH ${points}`,
        `HEIGHT 1`,
        `POINTS ${points}`,
        `DATA ascii`,
        '',
      ].join('\n');
    const enc = new TextEncoder();
    // 2 points x 3 columns x 2 bytes ("digit + delimiter") = 12 body bytes
    // with a trailing newline.
    const trailing = decodePcd(enc.encode(header(2) + '1 2 3\n4 5 6\n'));
    expect(trailing.pointCount).toBe(2);
    expect(Array.from(trailing.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    // A VALID file whose last record is EOF-terminated (no final newline) is
    // one byte under points*minBytes and must still decode — the floor is
    // points*minBytes - 1.
    const exactEof = decodePcd(enc.encode(header(2) + '1 2 3\n4 5 6')); // 11 bytes
    expect(exactEof.pointCount).toBe(2);
    expect(Array.from(exactEof.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    // One byte truncated below the floor: rejected before allocation.
    const short = enc.encode(header(2) + '1 2 3\n4 5 '); // 10 bytes
    expect(() => decodePcd(short)).toThrow(/body bytes|available/i);
  });

  it('rejects fractional, non-positive, or overflowing SIZE/COUNT fields', () => {
    const enc = new TextEncoder();
    const pcd = (size: string, count: string) =>
      enc.encode(
        [
          `VERSION 0.7`,
          `FIELDS x y z`,
          `SIZE ${size}`,
          `TYPE F F F`,
          `COUNT ${count}`,
          `WIDTH 1`,
          `HEIGHT 1`,
          `POINTS 1`,
          `DATA binary`,
          '',
        ].join('\n') + ' '.repeat(64),
      );
    // Fractional SIZE would poison every offset downstream.
    expect(() => decodePcd(pcd('4 4.5 4', '1 1 1'))).toThrow(/invalid field SIZE or COUNT/);
    // Zero / negative are not representable field widths.
    expect(() => decodePcd(pcd('4 0 4', '1 1 1'))).toThrow(/invalid field SIZE or COUNT/);
    expect(() => decodePcd(pcd('4 4 4', '1 -1 1'))).toThrow(/invalid field SIZE or COUNT/);
    // A single unsafe size*count product is rejected...
    expect(() => decodePcd(pcd('8 8 8', '1 9007199254740991 1'))).toThrow(
      /invalid field SIZE or COUNT/,
    );
    // ...and safe per-field products that accumulate past 2^53 trip the
    // stride-overflow check.
    expect(() => decodePcd(pcd('8 8 8', '900719925474099 900719925474099 1'))).toThrow(
      /field stride overflow/,
    );
  });
});

describe.skipIf(!FIXTURES_AVAILABLE)('decodePcd against IFCx fixtures', () => {
  it('decodes the small Point_Cloud sample (ascii subnode 213 points)', () => {
    const fixturePath = path.join(REPO_ROOT, 'tests/models/ifc5/Point_Cloud_point-cloud.ifcx');
    const ifcx = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
      data: Array<{ attributes?: Record<string, unknown> }>;
    };
    let pcdString: string | null = null;
    for (const node of ifcx.data) {
      const a = node.attributes ?? {};
      const v = a['pcd::base64'];
      if (typeof v === 'string') {
        pcdString = v;
        break;
      }
    }
    expect(pcdString).toBeTruthy();
    const bytes = Uint8Array.from(Buffer.from(pcdString!, 'base64'));
    const chunk = decodePcd(bytes);
    // Sample header declares POINTS 213
    expect(chunk.pointCount).toBe(213);
    expect(chunk.positions.length).toBe(213 * 3);
    // Bbox sanity: all z values are 0 in this fixture
    expect(chunk.bbox.min[2]).toBe(0);
    expect(chunk.bbox.max[2]).toBe(0);
  });

  it('decodes the large S1 scan (binary_compressed, ~101k points)', () => {
    const fixturePath = path.join(REPO_ROOT, 'tests/models/ifc5/Point_Cloud_S1-pointcloud.ifcx');
    const ifcx = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
      data: Array<{ attributes?: Record<string, unknown> }>;
    };
    const node = ifcx.data.find((n) => typeof n.attributes?.['pcd::base64'] === 'string');
    expect(node).toBeTruthy();
    const bytes = Uint8Array.from(Buffer.from(node!.attributes!['pcd::base64'] as string, 'base64'));
    const chunk = decodePcd(bytes);
    expect(chunk.pointCount).toBe(101694);
    expect(chunk.positions.length).toBe(101694 * 3);
    expect(chunk.colors).toBeDefined();
    // Bbox sanity: all components must be finite
    for (const v of [...chunk.bbox.min, ...chunk.bbox.max]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
