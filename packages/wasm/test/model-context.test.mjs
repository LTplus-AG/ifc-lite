/* SPDX-License-Identifier: MPL-2.0 */
/** Actual batch inputs remain per-call inputs when production owns snapshots. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const root = join(pkg, '..', '..');
const wasm = join(pkg, 'pkg', 'ifc-lite_bg.wasm');
const bindings = join(pkg, 'pkg', 'ifc-lite.js');
const styled = join(root, 'rust/processing/tests/fixtures/issue_6601_multicolor_element.ifc');
const wall = join(root, 'rust/processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc');

async function apiFor(t, fixture, run) {
  if (!existsSync(wasm) || !existsSync(bindings)) {
    t.skip('wasm bundle not built — run pnpm build:wasm');
    return;
  }
  const { initSync, IfcAPI } = await import(bindings);
  initSync({ module: readFileSync(wasm) });
  const api = new IfcAPI();
  try {
    const bytes = readFileSync(fixture);
    const pre = api.buildPrePassOnce(bytes);
    run(api, bytes, pre);
  } finally { api.clearPrePassCache(); api.free(); }
}

function batch(api, bytes, pre, { ids = pre.styleIds, colors = pre.styleColors,
  voidKeys = pre.voidKeys, voidCounts = pre.voidCounts, voidValues = pre.voidValues,
  materialIds, materialCounts, materialColors } = {}) {
  const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale,
    ...pre.rtcOffset, pre.needsShift, voidKeys, voidCounts, voidValues,
    ids, colors, undefined, materialIds, materialCounts, materialColors);
  try {
    return Array.from({ length: collection.length }, (_, i) => {
      const mesh = collection.get(i);
      try {
        return { id: mesh.expressId, item: mesh.geometryItemId,
          positions: Array.from(mesh.positions), indices: Array.from(mesh.indices),
          color: Array.from(mesh.color), metallic: mesh.metallic, roughness: mesh.roughness };
      } finally { mesh.free(); }
    });
  } finally { collection.free(); }
}

function closeColor(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-6,
    `color channel ${i}: ${value} != ${expected[i]}`));
}

function volume(mesh) {
  const p = mesh.positions, ids = mesh.indices;
  let sum = 0;
  for (let i = 0; i < ids.length; i += 3) {
    const a = ids[i] * 3, b = ids[i + 1] * 3, c = ids[i + 2] * 3;
    sum += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return Math.abs(sum / 6);
}

test('owned batch snapshots retain changing material overrides and omitted-field clearing', async t => {
  await apiFor(t, styled, (api, bytes, pre) => {
    const base = { ids: new Uint32Array(), colors: new Uint8Array(),
      materialIds: new Uint32Array([23]), materialCounts: new Uint32Array([2]) };
    const first = batch(api, bytes, pre, { ...base,
      materialColors: new Uint8Array([255, 0, 0, 102, 0, 0, 255, 255]) });
    assert.equal(first.length, 2);
    assert.ok(first.every(mesh => mesh.indices.length > 0));
    closeColor(first[0].color, [1, 0, 0, 0.4]);
    closeColor(first[1].color, [0, 0, 1, 1]);
    const next = batch(api, bytes, pre, { ...base,
      materialColors: new Uint8Array([0, 255, 0, 102, 255, 255, 0, 255]) });
    closeColor(next[0].color, [0, 1, 0, 0.4]);
    closeColor(next[1].color, [1, 1, 0, 1]);
    assert.deepEqual(next.map(m => [m.positions, m.indices]), first.map(m => [m.positions, m.indices]));
    const absent = batch(api, bytes, pre, { ids: base.ids, colors: base.colors });
    absent.forEach(mesh => closeColor(mesh.color, [0.6, 0.6, 0.6, 1]));
  });
});

test('owned snapshots preserve legacy style-cache matching while finishes change independently', async t => {
  await apiFor(t, styled, (api, bytes, pre) => {
    const first = batch(api, bytes, pre);
    assert.equal(first.length, 2);
    closeColor(first[0].color, [1, 0, 0, 1]);
    const blue = new Uint8Array(pre.styleColors.length);
    for (let i = 0; i < blue.length; i += 4) blue.set([0, 0, 255, 255], i);
    const collision = batch(api, bytes, pre, { colors: blue });
    assert.deepEqual(collision.map(m => m.color), first.map(m => m.color),
      'ownership-only migration deliberately preserves same-signature style cache reuse');
    const finishes = new Float32Array(pre.styleIds.length * 2).fill(0.25);
    api.setStyleFinishes(pre.styleIds, finishes);
    batch(api, bytes, pre).forEach(mesh => assert.equal(mesh.metallic, 0.25));
    finishes.fill(0.75);
    api.setStyleFinishes(pre.styleIds, finishes);
    batch(api, bytes, pre).forEach(mesh => assert.equal(mesh.metallic, 0.75));
    api.setStyleFinishes(new Uint32Array(), new Float32Array());
    batch(api, bytes, pre).forEach(mesh => assert.equal(mesh.metallic, undefined));
    api.clearPrePassCache();
    batch(api, bytes, pre, { colors: blue }).forEach(mesh => closeColor(mesh.color, [0, 0, 1, 1]));
  });
});

test('new snapshots use the current opening wire instead of freezing the first batch', async t => {
  await apiFor(t, wall, (api, bytes, pre) => {
    assert.ok(pre.voidKeys.length > 0);
    const host = meshes => meshes.filter(mesh => mesh.id === 30);
    const cut = host(batch(api, bytes, pre));
    const solid = host(batch(api, bytes, pre, { voidKeys: new Uint32Array(),
      voidCounts: new Uint32Array(), voidValues: new Uint32Array() }));
    assert.equal(solid.length, 1);
    assert.ok(Math.abs(volume(solid[0]) - 2.4) < 1e-5);
    assert.ok(cut.length > 0 && cut.reduce((sum, mesh) => sum + volume(mesh), 0) < 2.3);
    const again = host(batch(api, bytes, pre));
    assert.deepEqual(again, cut, 'later batches must recover the original actual cut and buffers');
  });
});
