/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import {
  appearanceSourceTriangle,
  expandAppearanceCorners,
  equivalentAppearanceGeometry,
} from './appearance-uvs.js';
import { splitMeshForStreaming } from './scene-stream-split.js';
function sourceMesh(): MeshData {
  const indices = new Uint32Array([2, 0, 1, 3, 2, 1, 2, 3, 0]);
  return {
    expressId: 7,
    geometryItemId: 14,
    color: [1, 1, 1, 1],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]),
    normals: new Float32Array(12),
    indices,
    appearanceSource: {
      kind: 'canonical-item',
      indices,
      sourceIndices: indices,
    },
  };
}
describe('canonical appearance corner provenance (#4243)', () => {
  it('resolves full-surface ordinals through streamed and masked subsets (#4555)', () => {
    const mesh = sourceMesh();
    const fragments = splitMeshForStreaming(mesh, 3, 4096);
    assert.deepEqual(fragments.map(fragment => appearanceSourceTriangle(fragment, 0)), [0, 1, 2]);

    const indices = new Uint32Array([3, 2, 1, 2, 0, 1]);
    const masked: MeshData = { ...mesh, indices, appearanceSource: {
      kind: 'canonical-item', indices, sourceIndices: mesh.indices,
      cornerIndices: new Uint32Array([3, 4, 5, 0, 1, 2]),
    } };
    assert.equal(appearanceSourceTriangle(masked, 0), 1);
    assert.equal(appearanceSourceTriangle(masked, 1), 0);
    masked.appearanceSource!.cornerIndices![2] = 6;
    assert.equal(appearanceSourceTriangle(masked, 0), undefined, 'mixed source triangles refuse');
    masked.appearanceSource!.indices = new Uint32Array(indices);
    assert.equal(appearanceSourceTriangle(masked, 1), undefined, 'rebuilt topology refuses');
  });
  it('composes repeated fragments and expands welded vertices without losing UV seams', () => {
    const mesh = sourceMesh(),
      uvs = Array.from({ length: 18 }, (_, index) => index / 4);
    const fragments = splitMeshForStreaming(mesh, 6, 4096).flatMap((piece) =>
      splitMeshForStreaming(piece, 3, 4096),
    );
    let corner = 0;
    for (const fragment of fragments) {
      const expanded = expandAppearanceCorners(
        fragment,
        mesh.indices,
        uvs,
        mesh.indices,
        new Float32Array(27),
        4,
      );
      assert.ok(equivalentAppearanceGeometry(fragment, expanded));
      assert.ok(
        equivalentAppearanceGeometry(expanded, fragment),
        'compressed undo remains equivalent',
      );
      for (const index of expanded.indices) {
        assert.deepEqual(
          Array.from(expanded.uvs!.slice(index * 2, index * 2 + 2)),
          uvs.slice(corner * 2, corner * 2 + 2),
        );
        corner++;
      }
    }
    assert.equal(corner, mesh.indices.length);
    const expanded = expandAppearanceCorners(
      mesh,
      mesh.indices,
      uvs,
      mesh.indices,
      new Float32Array(27),
      4,
    );
    assert.equal(
      expanded.positions.length / 3,
      9,
      'four welded vertices become nine independent corners',
    );
    expanded.positions[0] += 1;
    assert.equal(
      equivalentAppearanceGeometry(mesh, expanded),
      false,
      'a real geometry move must fail',
    );
  });
  it('carries target weld provenance into the next Apply and restores the old provenance on undo', () => {
    const mesh = sourceMesh(),
      target = Uint32Array.from({ length: 9 }, (_, index) => index);
    const first = expandAppearanceCorners(
      mesh,
      mesh.indices,
      new Float32Array(18),
      target,
      new Float32Array(27),
      9,
    );
    assert.strictEqual(first.appearanceSource!.sourceIndices, target);
    const second = expandAppearanceCorners(
      first,
      target,
      new Float32Array(18).fill(0.25),
      mesh.indices,
      new Float32Array(27),
      4,
    );
    assert.ok(equivalentAppearanceGeometry(first, second));
    assert.ok(equivalentAppearanceGeometry(second, mesh));
    assert.strictEqual(second.appearanceSource!.sourceIndices, mesh.indices);
    assert.throws(
      () =>
        expandAppearanceCorners(
          first,
          mesh.indices,
          new Float32Array(18),
          target,
          new Float32Array(27),
          9,
        ),
      /topology changed/,
    );
  });
  it('installs exact canonical corner normals while keeping history validation strict', () => {
    const mesh = sourceMesh();
    const targetNormals = Float32Array.from({ length: 27 }, (_, i) => i / 1000);
    const fragments = splitMeshForStreaming(mesh, 3, 4096);
    for (const fragment of fragments) {
      const expanded = expandAppearanceCorners(
        fragment,
        mesh.indices,
        new Float32Array(18),
        mesh.indices,
        targetNormals,
        4,
      );
      assert.equal(equivalentAppearanceGeometry(fragment, expanded), false);
      assert.ok(
        equivalentAppearanceGeometry(fragment, expanded, {
          allowNormalChanges: true,
        }),
      );
      for (let i = 0; i < expanded.indices.length; i++) {
        const corner = fragment.appearanceSource!.cornerIndices![i];
        assert.deepEqual(
          expanded.normals.slice(i * 3, i * 3 + 3),
          targetNormals.slice(corner * 3, corner * 3 + 3),
        );
      }
      expanded.positions[0] += 1;
      assert.equal(
        equivalentAppearanceGeometry(fragment, expanded, {
          allowNormalChanges: true,
        }),
        false,
      );
    }
    for (const invalid of [
      new Float32Array(3),
      new Float32Array(27).fill(Infinity),
    ]) {
      assert.throws(
        () =>
          expandAppearanceCorners(
            mesh,
            mesh.indices,
            new Float32Array(18),
            mesh.indices,
            invalid,
            4,
          ),
        /provenance|finite/,
      );
    }
  });
  it('rejects changed origin or placement even when geometry arrays are identical', () => {
    const mesh = sourceMesh();
    for (const changed of [
      { ...mesh, origin: [1, 0, 0] as [number, number, number] },
      { ...mesh, localToWorld: [1, 0, 0, 1] },
    ]) {
      assert.equal(equivalentAppearanceGeometry(mesh, changed), false);
      assert.equal(
        equivalentAppearanceGeometry(mesh, changed, {
          allowNormalChanges: true,
        }),
        false,
      );
    }
    const located = { ...mesh, origin: [0, 1, 2] as [number, number, number] };
    assert.ok(
      equivalentAppearanceGeometry(located, { ...located, origin: [0, 1, 2] }),
    );
    assert.equal(
      equivalentAppearanceGeometry(located, { ...located, origin: [0, 1, 3] }),
      false,
    );
  });
  it('accepts retained unused target vertices while rejecting indices outside the actual pool', () => {
    // Canonical Convento item187 has27 corners but references vertex27.
    // A single triangle with an unused first vertex proves the same invariant.
    const indices = new Uint32Array([1, 2, 3]);
    const mesh: MeshData = {
      ...sourceMesh(),
      indices,
      appearanceSource: {
        kind: 'canonical-item',
        indices,
        sourceIndices: indices,
      },
    };
    const expanded = expandAppearanceCorners(
      mesh,
      indices,
      new Float32Array(6),
      indices,
      new Float32Array(9),
      4,
    );
    assert.ok(equivalentAppearanceGeometry(mesh, expanded));
    assert.deepEqual(expanded.appearanceSource!.sourceIndices, indices);
    assert.throws(
      () =>
        expandAppearanceCorners(
          mesh,
          indices,
          new Float32Array(6),
          indices,
          new Float32Array(9),
          3,
        ),
      /target topology/,
    );
    for (const invalid of [0, -1, NaN, Infinity, 4.5, 0x100000001]) {
      assert.throws(
        () =>
          expandAppearanceCorners(
            mesh,
            indices,
            new Float32Array(6),
            indices,
            new Float32Array(9),
            invalid,
          ),
        /vertex pool/,
      );
    }
  });
  it('rejects equal-size rebuilt topology, even after another streaming split', () => {
    const mesh = sourceMesh(),
      changed = { ...mesh, indices: mesh.indices.slice() };
    assert.throws(
      () =>
        expandAppearanceCorners(
          changed,
          mesh.indices,
          new Float32Array(18),
          mesh.indices,
          new Float32Array(27),
          4,
        ),
      /provenance/,
    );
    for (const piece of splitMeshForStreaming(changed, 3, 4096)) {
      assert.throws(
        () =>
          expandAppearanceCorners(
            piece,
            mesh.indices,
            new Float32Array(18),
            mesh.indices,
            new Float32Array(27),
            4,
          ),
        /provenance/,
      );
    }
    const altered = mesh.indices.slice();
    altered[0] = 1;
    assert.throws(
      () =>
        expandAppearanceCorners(
          mesh,
          altered,
          new Float32Array(18),
          mesh.indices,
          new Float32Array(27),
          4,
        ),
      /topology changed/,
    );
  });
  it('survives worker clone, checks corner bounds and rejects non-finite UVs', () => {
    const mesh = structuredClone(sourceMesh());
    assert.strictEqual(mesh.appearanceSource!.indices, mesh.indices);
    assert.strictEqual(mesh.appearanceSource!.sourceIndices, mesh.indices);
    assert.equal(
      expandAppearanceCorners(
        mesh,
        mesh.indices,
        new Float32Array(18),
        mesh.indices,
        new Float32Array(27),
        4,
      ).uvs!.length,
      18,
    );
    assert.throws(
      () =>
        expandAppearanceCorners(
          mesh,
          mesh.indices,
          new Float32Array(6),
          mesh.indices,
          new Float32Array(27),
          4,
        ),
      /provenance/,
    );
    assert.throws(
      () =>
        expandAppearanceCorners(
          mesh,
          mesh.indices,
          new Float32Array(18).fill(Infinity),
          mesh.indices,
          new Float32Array(27),
          4,
        ),
      /finite/,
    );
    mesh.appearanceSource!.cornerIndices = new Uint32Array(9).fill(99);
    assert.throws(
      () =>
        expandAppearanceCorners(
          mesh,
          mesh.indices,
          new Float32Array(18),
          mesh.indices,
          new Float32Array(27),
          4,
        ),
      /out of range/,
    );
  });
});
