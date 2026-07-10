/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { chunkCellKey, bucketBaseKeyFor } from './chunk-grid.ts';

const mesh = (firstVertex: [number, number, number], origin?: [number, number, number]) => ({
  positions: new Float32Array([...firstVertex, 999, 999, 999]),
  ...(origin ? { origin } : {}),
});

describe('chunkCellKey', () => {
  it('assigns the cell of origin + first vertex', () => {
    assert.strictEqual(chunkCellKey(mesh([1, 2, 3]), 32), '0,0,0');
    assert.strictEqual(chunkCellKey(mesh([33, 2, 3]), 32), '1,0,0');
    assert.strictEqual(chunkCellKey(mesh([1, 2, 3], [64, 0, -64]), 32), '2,0,-2');
  });

  it('floors negative coordinates into negative cells (no cell straddles zero)', () => {
    assert.strictEqual(chunkCellKey(mesh([-0.5, -31.9, -32.1]), 32), '-1,-1,-2');
  });

  it('is deterministic and independent of later vertices', () => {
    const a = mesh([5, 5, 5]);
    const b = { positions: new Float32Array([5, 5, 5, -500, 0, 500]) };
    assert.strictEqual(chunkCellKey(a, 32), chunkCellKey(b, 32));
  });

  it('anchors an empty mesh at its origin', () => {
    assert.strictEqual(chunkCellKey({ positions: new Float32Array(0), origin: [100, 0, 0] }, 32), '3,0,0');
    assert.strictEqual(chunkCellKey({ positions: new Float32Array(0) }, 32), '0,0,0');
  });

  it('routes non-finite anchors to the dedicated nan cell', () => {
    assert.strictEqual(chunkCellKey({ positions: new Float32Array([NaN, 0, 0]) }, 32), 'nan');
  });
});

describe('bucketBaseKeyFor', () => {
  const colorKey = '500|500|500|1000';

  it('is the plain colour key when chunking is off', () => {
    assert.strictEqual(bucketBaseKeyFor(mesh([1, 2, 3]), colorKey, null), colorKey);
  });

  it('prefixes the cell when chunking is on', () => {
    assert.strictEqual(
      bucketBaseKeyFor(mesh([33, 2, 3]), colorKey, { cellSize: 32 }),
      `1,0,0~${colorKey}`,
    );
  });

  it('separates same colour in different cells and same cell in different colours', () => {
    const cfg = { cellSize: 32 };
    const a = bucketBaseKeyFor(mesh([1, 0, 0]), colorKey, cfg);
    const b = bucketBaseKeyFor(mesh([100, 0, 0]), colorKey, cfg);
    const c = bucketBaseKeyFor(mesh([1, 0, 0]), '0|0|0|1000', cfg);
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a, c);
  });

  it('round-trips through the "#N" overflow-suffix strip (lastIndexOf contract)', () => {
    // resolveActiveBucket appends "#N"; baseColorKey strips at the LAST "#".
    // Neither cell keys nor colour keys may contain "#".
    const base = bucketBaseKeyFor(mesh([33, 2, 3], [-64, 0, 0]), colorKey, { cellSize: 32 });
    assert.ok(!base.includes('#'));
    const suffixed = `${base}#7`;
    assert.strictEqual(suffixed.substring(0, suffixed.lastIndexOf('#')), base);
  });
});
