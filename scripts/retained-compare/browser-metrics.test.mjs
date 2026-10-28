// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareView, float32Ulp, vertexDeviation } from './browser-metrics.mjs';

test('#7955 M2-D: one local f32 ulp at 2600 km must fail before world f32 cast', () => {
  const world = 2_600_001, ulp = float32Ulp(1);
  assert.equal(Math.fround(world), Math.fround(world + ulp), 'world f32 cast hides the displacement');
  assert.equal(vertexDeviation(world + ulp, world, 1).valid, false);
  assert.equal(vertexDeviation(world + ulp / 2, world, 1).valid, true);
  assert.equal(vertexDeviation(world, world, 1).valid, true);
});

test('#7955 storage spacing includes zero, subnormals, negative values and finite checks', () => {
  assert.equal(float32Ulp(0), 2 ** -149);
  assert.equal(float32Ulp(2 ** -140), 2 ** -149);
  assert.equal(float32Ulp(-2), 2 ** -22);
  for (const value of [NaN, Infinity, -Infinity]) assert.equal(vertexDeviation(value, value, 1).valid, false);
  assert.equal(vertexDeviation(1, 1, 1.1).valid, false);
});

function triangle() {
  const frame = { needsShift: true, rtcOffset: [2_600_000, 5_000_000, 10] };
  const start = { frame, candidateIds: [17, 18] };
  const part = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2],
    worldFromObject: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...frame.rtcOffset, 1] };
  const refusal = { expressId: 18, status: 'refused', code: 'operation_unsupported' };
  return { prepass: frame,
    shape: { start, outcomes: [{ expressId: 17, status: 'published', parts: [part] }, refusal] },
    view: { start, outcomes: [{ expressId: 17, status: 'published', meshes: [{ expressId: 17,
      origin: [0, 0, 0], rtcOffset: frame.rtcOffset, positions: [0, 0, 0, 1, 0, 0, 0, 0, -1], indices: [0, 1, 2] }] }, refusal] } };
}

test('#7955 view witness authenticates axes, RTC, triangles, refusals and product universe', () => {
  const original = triangle();
  assert.deepEqual(compareView(original.shape, original.view, original.prepass), {
    vertices: 3, triangles: 1, maxVertexMetres: 0, maxVertexUlps: 0, violations: [],
  });
  const mutations = [
    x => { x.view.outcomes[0].meshes[0].positions[3] += float32Ulp(1); },
    x => { x.view.outcomes[0].meshes[0].positions[8] = 1; },
    x => { x.view.outcomes[0].meshes[0].indices.pop(); },
    x => { x.view.outcomes[0].meshes[0].expressId = 18; },
    x => { x.view.outcomes[1] = { ...x.view.outcomes[1], meshes: [{}] }; },
    x => { x.view.outcomes[1] = { ...x.view.outcomes[1], code: 'contract_breach' }; },
    x => { x.view.outcomes.pop(); },
    x => { x.view.start = { ...x.view.start, frame: { ...x.view.start.frame, needsShift: false } }; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(original); mutate(changed);
    assert.ok(compareView(changed.shape, changed.view, changed.prepass).violations.length > 0);
  }
});
