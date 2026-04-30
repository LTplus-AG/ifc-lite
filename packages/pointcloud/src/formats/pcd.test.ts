/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePcd } from './pcd.js';

// Vitest currently injects `__dirname` even in ESM packages, but a fresh
// node-runner will not. Resolve the repo root via `import.meta.url` so the
// fixture-loading tests don't break when this is run outside vitest.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');

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

describe('decodePcd against IFCx fixtures', () => {
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
