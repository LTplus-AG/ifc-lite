/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  composeInstanceMatrix,
  writeInstanceRecord,
  prepareInstancedRender,
  INSTANCE_STRIDE_BYTES,
  INSTANCE_FLAGS_OFFSET,
  INSTANCE_FLAG_SELECTED,
} from './instanced-render.js';

// --- frame helpers (independent re-derivation of the expected world coord) ---

/** Apply a column-major mat4 (the composeInstanceMatrix output) to a point. */
function applyColMajor(m: Float32Array, p: readonly [number, number, number]): [number, number, number] {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Apply a row-major mat4 (the IFNS rel_k convention) to a point. */
function applyRowMajor(rm: Float32Array, p: readonly [number, number, number]): [number, number, number] {
  const [x, y, z] = p;
  return [
    rm[0] * x + rm[1] * y + rm[2] * z + rm[3],
    rm[4] * x + rm[5] * y + rm[6] * z + rm[7],
    rm[8] * x + rm[9] * y + rm[10] * z + rm[11],
  ];
}

/** The IFC Z-up → WebGL Y-up swap MeshDataJs::new bakes into the flat path. */
function swap([x, y, z]: readonly [number, number, number]): [number, number, number] {
  return [x, z, -y];
}

const rowMajorIdentity = () =>
  new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const rowMajorTranslation = (tx: number, ty: number, tz: number) =>
  new Float32Array([1, 0, 0, tx, 0, 1, 0, ty, 0, 0, 1, tz, 0, 0, 0, 1]);

const rowMajorRotZ = (theta: number) => {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return new Float32Array([c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
};

function assertClose(
  got: readonly [number, number, number],
  want: readonly [number, number, number],
  msg: string,
  eps = 1e-5,
) {
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(got[i] - want[i]) < eps,
      `${msg}: axis ${i} got ${got[i]} want ${want[i]}`,
    );
  }
}

/**
 * The contract: composeInstanceMatrix(rel_k, origin) applied to a template's
 * LOCAL vertex p must equal the flat path's world coordinate for that occurrence,
 * which is swap(rel_k · (origin + p)). This independently re-derives the RHS.
 */
function expectedRenderCoord(
  relK: Float32Array,
  origin: readonly [number, number, number],
  pLocal: readonly [number, number, number],
): [number, number, number] {
  const nativeWorld: [number, number, number] = [
    origin[0] + pLocal[0],
    origin[1] + pLocal[1],
    origin[2] + pLocal[2],
  ];
  return swap(applyRowMajor(relK, nativeWorld));
}

describe('composeInstanceMatrix — frame correctness vs the flat path', () => {
  it('identity rel_k + origin: only the Z-up→Y-up swap of (origin + p)', () => {
    const relK = rowMajorIdentity();
    const origin: [number, number, number] = [1, 2, 3];
    const p: [number, number, number] = [0.5, 0.6, 0.7];
    const mat = composeInstanceMatrix(relK, origin);
    // (origin + p) = [1.5, 2.6, 3.7]; swap → [1.5, 3.7, -2.6]
    assertClose(applyColMajor(mat, p), [1.5, 3.7, -2.6], 'identity');
    assertClose(applyColMajor(mat, p), expectedRenderCoord(relK, origin, p), 'identity vs derived');
  });

  it('translation rel_k folds before the swap', () => {
    const relK = rowMajorTranslation(10, 20, 30);
    const origin: [number, number, number] = [1, 2, 3];
    const p: [number, number, number] = [0.5, 0.6, 0.7];
    const mat = composeInstanceMatrix(relK, origin);
    // rel_k·(origin+p) = [11.5, 22.6, 33.7]; swap → [11.5, 33.7, -22.6]
    assertClose(applyColMajor(mat, p), [11.5, 33.7, -22.6], 'translation');
    assertClose(applyColMajor(mat, p), expectedRenderCoord(relK, origin, p), 'translation vs derived');
  });

  it('rotation rel_k (90° about native Z) composes in the right order', () => {
    const relK = rowMajorRotZ(Math.PI / 2);
    const origin: [number, number, number] = [0, 0, 0];
    const p: [number, number, number] = [1, 0, 0];
    const mat = composeInstanceMatrix(relK, origin);
    // rotZ90·[1,0,0] = [0,1,0]; swap([0,1,0]) = [0,0,-1]
    assertClose(applyColMajor(mat, p), [0, 0, -1], 'rotZ90');
    assertClose(applyColMajor(mat, p), expectedRenderCoord(relK, origin, p), 'rotZ90 vs derived');
  });

  it('rotation + translation + origin, multiple vertices', () => {
    const relK = rowMajorRotZ(Math.PI / 3);
    relK[3] = 5; // tx
    relK[7] = -2; // ty
    relK[11] = 9; // tz
    const origin: [number, number, number] = [12.5, -3.25, 7.0];
    for (const p of [
      [0, 0, 0],
      [1, 2, 3],
      [-4.5, 0.25, 8.0],
    ] as const) {
      const mat = composeInstanceMatrix(relK, origin);
      assertClose(applyColMajor(mat, p), expectedRenderCoord(relK, origin, p), `vertex ${p}`);
    }
  });
});

describe('writeInstanceRecord — GPU buffer byte layout', () => {
  it('packs mat4(0..63) + entityId(64) + rgba(68..83), little-endian', () => {
    const buf = new ArrayBuffer(INSTANCE_STRIDE_BYTES);
    const dv = new DataView(buf);
    const mat = new Float32Array(16);
    for (let i = 0; i < 16; i++) mat[i] = i + 0.5;
    writeInstanceRecord(dv, 0, mat, 4242, [0.1, 0.2, 0.3, 0.4], INSTANCE_FLAG_SELECTED);

    assert.strictEqual(INSTANCE_STRIDE_BYTES, 88);
    for (let i = 0; i < 16; i++) {
      assert.ok(Math.abs(dv.getFloat32(i * 4, true) - (i + 0.5)) < 1e-6, `mat[${i}]`);
    }
    assert.strictEqual(dv.getUint32(64, true), 4242, 'entityId');
    const expectedColor = [0.1, 0.2, 0.3, 0.4];
    for (let j = 0; j < 4; j++) {
      assert.ok(
        Math.abs(dv.getFloat32(68 + j * 4, true) - expectedColor[j]) < 1e-6,
        `color[${j}]`,
      );
    }
    assert.strictEqual(dv.getUint32(INSTANCE_FLAGS_OFFSET, true), INSTANCE_FLAG_SELECTED, 'flags');
  });

  it('defaults flags to 0 (unselected) when omitted', () => {
    const buf = new ArrayBuffer(INSTANCE_STRIDE_BYTES);
    const dv = new DataView(buf);
    writeInstanceRecord(dv, 0, new Float32Array(16), 7, [1, 1, 1, 1]);
    assert.strictEqual(dv.getUint32(INSTANCE_FLAGS_OFFSET, true), 0, 'flags default 0');
  });
});

describe('prepareInstancedRender — grouping + buffer assembly', () => {
  it('groups instances by template, sizes buffers, composes matrices', () => {
    const origin0: [number, number, number] = [1, 2, 3];
    const origin1: [number, number, number] = [-5, 0, 4];
    const shard = {
      templates: [
        { positions: new Float32Array([0, 0, 0]), normals: new Float32Array([0, 1, 0]), indices: new Uint32Array([0]), origin: origin0 },
        { positions: new Float32Array([1, 1, 1]), normals: new Float32Array([0, 0, 1]), indices: new Uint32Array([0]), origin: origin1 },
      ],
      instances: [
        { templateIndex: 0, entityId: 11, color: [1, 0, 0, 1] as [number, number, number, number], transform: rowMajorTranslation(0, 0, 0) },
        { templateIndex: 1, entityId: 22, color: [0, 1, 0, 1] as [number, number, number, number], transform: rowMajorTranslation(7, 0, 0) },
        { templateIndex: 0, entityId: 33, color: [0, 0, 1, 1] as [number, number, number, number], transform: rowMajorTranslation(0, 5, 0) },
      ],
    };

    const out = prepareInstancedRender(shard);
    assert.strictEqual(out.length, 2, 'two templates with occurrences');

    const t0 = out.find((t) => t.templateIndex === 0)!;
    const t1 = out.find((t) => t.templateIndex === 1)!;
    assert.strictEqual(t0.instanceCount, 2, 'template 0 has 2 occurrences');
    assert.deepStrictEqual(Array.from(t0.entityIds), [11, 33], 'template 0 entityIds in buffer order');
    assert.strictEqual(t1.instanceCount, 1, 'template 1 has 1 occurrence');
    assert.strictEqual(t0.instanceBuffer.byteLength, 2 * INSTANCE_STRIDE_BYTES);
    assert.strictEqual(t1.instanceBuffer.byteLength, 1 * INSTANCE_STRIDE_BYTES);

    // First occurrence of template 0: identity rel_k → instMat applied to its
    // local vertex equals swap(origin0 + p).
    const dv = new DataView(t0.instanceBuffer);
    const mat = new Float32Array(16);
    for (let i = 0; i < 16; i++) mat[i] = dv.getFloat32(i * 4, true);
    assert.strictEqual(dv.getUint32(64, true), 11, 'first entityId');
    const p: [number, number, number] = [0.25, 0.5, 0.75];
    assertClose(applyColMajor(mat, p), swap([origin0[0] + p[0], origin0[1] + p[1], origin0[2] + p[2]]), 'template0 inst0');
  });

  it('excludes transparent instances (alpha < 0.99) so glass renders via the flat path', () => {
    const origin: [number, number, number] = [0, 0, 0];
    const shard = {
      templates: [
        { positions: new Float32Array([0, 0, 0]), normals: new Float32Array([0, 1, 0]), indices: new Uint32Array([0]), origin },
        // template 1: ONLY transparent occurrences → should be dropped entirely.
        { positions: new Float32Array([1, 1, 1]), normals: new Float32Array([0, 0, 1]), indices: new Uint32Array([0]), origin },
      ],
      instances: [
        { templateIndex: 0, entityId: 1, color: [1, 0, 0, 1] as [number, number, number, number], transform: rowMajorIdentity() }, // opaque → kept
        { templateIndex: 0, entityId: 2, color: [0.6, 0.8, 0.9, 0.3] as [number, number, number, number], transform: rowMajorIdentity() }, // glass → dropped
        { templateIndex: 1, entityId: 3, color: [0.6, 0.8, 0.9, 0.5] as [number, number, number, number], transform: rowMajorIdentity() }, // glass → dropped
      ],
    };

    const out = prepareInstancedRender(shard);
    assert.strictEqual(out.length, 1, 'only the template with an opaque occurrence survives');
    const t0 = out[0];
    assert.strictEqual(t0.templateIndex, 0);
    assert.strictEqual(t0.instanceCount, 1, 'the transparent occurrence of template 0 is excluded');
    const dv = new DataView(t0.instanceBuffer);
    assert.strictEqual(dv.getUint32(64, true), 1, 'the kept instance is the opaque one (entityId 1)');
  });
});
