// SPDX-License-Identifier: MPL-2.0
// Synthetic fixture checks for the numerical oracle ONLY; no SDK evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { meshWitness } from './mesh-witness.mjs';
import { regionWitnesses } from './region-recipes.mjs';
function annularMesh(fixture, { moved = false, fillHole = false, shift = 0 } = {}) {
  const n = 512, positions = [], indices = [];
  const inner = fixture.holes[0][2];
  for (const z of [0, fixture.depth * fixture.direction[2]]) {
    for (const r of [2, inner]) for (let i = 0; i < n; i++) {
      const p = [r * Math.cos(i * 2 * Math.PI / n) + z * fixture.direction[0] / fixture.direction[2] + shift,
        r * Math.sin(i * 2 * Math.PI / n), z];
      positions.push(...(moved ? [p[2] + 10, p[0] + 20, p[1] + 30] : p));
    }
  }
  const quad = (a, b, c, d) => indices.push(a, b, c, a, c, d);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    quad(i, i + n, j + n, j); // bottom annular cap
    quad(i + 2*n, j + 2*n, j + 3*n, i + 3*n); // top
    quad(i, j, j + 2*n, i + 2*n); // outer wall
    quad(i + n, i + 3*n, j + 3*n, j + n); // inner wall
  }
  if (fillHole) indices.push(n, n + n/3 | 0, n + 2*n/3 | 0);
  const floats = new Float64Array(positions), ints = new Uint32Array(indices);
  return async (op, ...fields) => {
    if (op === 9) return new Uint8Array(16);
    if (op === 10) return new Uint8Array(new Uint32Array([positions.length/3, indices.length/3, 4, 0, 0, 0]).buffer);
    if (op === 11) {
      const [stream, offset, count] = fields.slice(2).map(bytes => new DataView(bytes.buffer).getUint32(0, true));
      const data = stream === 1 ? floats : ints;
      return new Uint8Array(data.slice(offset, offset + count).buffer);
    }
    if (op === 8) return new Uint8Array();
    throw new Error(`unexpected fixture operation ${op}`);
  };
}
for (const name of ['annulus-normal-1', 'oblique-annulus', 'millimetre-derived-annulus']) {
  test(`round3 numerical oracle: ${name} mesh and rotated copy`, async () => {
    const fixture = regionWitnesses().find(f => f.name === name);
    for (const moved of [false, true]) {
      const result = await meshWitness(annularMesh(fixture, { moved }), new Uint8Array(8),
        new Uint8Array(16), fixture.expected, fixture, moved);
      assert(Math.abs(result.meshSectionArea - fixture.area) < fixture.area * 0.002);
    }
  });
}
test('round3 numerical oracle rejects a cap triangle filling an annular hole', async () => {
  const fixture = regionWitnesses().find(f => f.name === 'annulus-normal-1');
  await assert.rejects(meshWitness(annularMesh(fixture, { fillHole: true }), new Uint8Array(8),
    new Uint8Array(16), fixture.expected, fixture), /inside swept hole/);
});
test('round3 numerical oracle rejects a volume-preserving incorrect translation', async () => {
  const fixture = regionWitnesses().find(f => f.name === 'annulus-normal-1');
  await assert.rejects(meshWitness(annularMesh(fixture, { shift: 0.1 }), new Uint8Array(8),
    new Uint8Array(16), fixture.expected, fixture), /tight mesh bounds/);
});
