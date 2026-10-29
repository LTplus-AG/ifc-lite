// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runComparison } from './run.mjs';
const engine = process.env.IFCLITE_RETAINED_ENGINE;
test('#7955 M4 CLI band tags and capped volumes match native at 1e-9', {
  timeout: 600000,
  skip: !(engine && existsSync(engine)) && 'SKIP: no staged SMLib engine; this is NOT parity evidence',
}, async () => {
  assert.ok(process.env.IFCLITE_M3_REFERENCE, 'M4 native reference is required');
  const reference = JSON.parse(await readFile(process.env.IFCLITE_M3_REFERENCE, 'utf8'));
  const scratch = await mkdtemp(join(tmpdir(), 'm4-bands-parity-'));
  try {
    for (const [name, model] of [
      ['m4straight', 'tests/fixtures/cli-retained/layered-wall.ifc'],
      ['m4curved', 'tests/fixtures/synthetic-retained/f-a-curved.ifc'],
      ['m4synthetic', 'tests/fixtures/synthetic-retained/f-g-layers.ifc'],
    ]) {
      assert.ok(reference[name]?.length > 0, `${name} native observations required`);
      const output = join(scratch, name);
      await mkdir(output);
      const child = spawnSync(process.execPath, ['scripts/retained-compare/child.mjs', resolve(engine), model, output],
        { encoding: 'utf8', timeout: 270000, maxBuffer: 16 * 1024 * 1024 });
      if (child.error) throw child.error;
      assert.equal(child.status, 0, child.stderr);
      const products = JSON.parse(child.stdout);
      for (const expected of reference[name]) {
        const matches = products.filter(row => row.id === expected.id);
        assert.equal(matches.length, 1, `one atomic outcome for #${expected.id}`);
        const actual = matches[0];
        assert.equal(actual.code ?? actual.status, expected.code, `#${expected.id}`);
        if (expected.code !== 'published') { assert.equal(actual.parts, undefined); continue; }
        assert.equal(actual.marker, 'final', 'M11-Z CLI report exposes final layered products');
        assert.deepEqual(actual.obligationsUnmet, []);
        assert.equal(actual.parts.length, expected.bands.length);
        for (const [index, band] of expected.bands.entries()) {
          const part = actual.parts[index];
          assert.deepEqual(part.layer, { index: band.index, materialId: band.materialId });
          assert.equal(part.materialId, band.materialId, 'appearance belongs to the layer material');
          assert.ok(Array.isArray(part.color) && part.color.length === 4 && part.color.every(Number.isFinite));
          const relative = Math.abs(part.volumeM3 - band.volume) / Math.abs(band.volume);
          assert.ok(Number.isFinite(relative) && relative <= 1e-9,
            `#${expected.id} band ${band.index}: native ${band.volume}, Node/wasm ${part.volumeM3}`);
        }
      }
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
test('#7955 built CLI matches native codes and f64 volumes on committed models', {
  timeout: 1800000,
  skip: !(engine && existsSync(engine)) && 'SKIP: no staged SMLib engine; this is NOT parity evidence',
}, async () => {
  assert.ok(process.env.IFCLITE_NATIVE_PRODUCTS, 'native products.tsv is required');
  const result = await runComparison({ engine, native: process.env.IFCLITE_NATIVE_PRODUCTS });
  assert.equal(result.violations.length, 0);
  assert.ok(result.products > 0);
});

test('#7955 M3 unreviewed synthetic cases, including the baked scaled cutter, match native', {
  timeout: 600000,
  skip: !(engine && existsSync(engine)) && 'SKIP: no staged SMLib engine; this is NOT parity evidence',
}, async () => {
  assert.ok(process.env.IFCLITE_M3_REFERENCE, 'M3 native reference is required');
  const { synthetic, nonbakeable } = JSON.parse(await readFile(process.env.IFCLITE_M3_REFERENCE, 'utf8'));
  assert.ok(synthetic.some(row => row.id === 203), 'scaled cutter host must be in native reference');
  const tolerances = JSON.parse(await readFile('tests/fixtures/cli-retained/tolerances.json', 'utf8'));
  const scratch = await mkdtemp(join(tmpdir(), 'm3-synthetic-parity-'));
  try {
    // f-d remains unreviewed and outside the blessed coverage manifest.
    const fixture = 'tests/fixtures/synthetic-retained/f-d-openings.ifc';
    const overflow = join(scratch, 'nonbakeable.ifc');
    await writeFile(overflow, (await readFile(fixture, 'utf8')).replace(
      'OPERATOR3D($,$,#1,2.,$)', 'OPERATOR3DNONUNIFORM($,$,#1,1.E200,$,1.E200,1.)'));
    for (const [name, model, reference] of [['synthetic', fixture, synthetic], ['nonbakeable', overflow, nonbakeable]]) {
      assert.ok(reference.length > 0, `${name} native observations required`);
      const output = join(scratch, name);
      await mkdir(output);
      const child = spawnSync(process.execPath, ['scripts/retained-compare/child.mjs', resolve(engine), model, output],
        { encoding: 'utf8', timeout: 270000, maxBuffer: 16 * 1024 * 1024 });
      if (child.error) throw child.error;
      assert.equal(child.status, 0, child.stderr);
      const products = JSON.parse(child.stdout);
      for (const expected of reference) {
        const matches = products.filter(row => row.id === expected.id);
        assert.equal(matches.length, 1, `one atomic outcome for #${expected.id}`);
        const actual = matches[0];
        assert.equal(actual.code ?? actual.status, expected.code, `#${expected.id}`);
        assert.notEqual(actual.code, 'contract_breach');
        if (expected.code === 'published') {
          const relative = Math.abs(actual.volumeM3 - expected.volume) / Math.abs(expected.volume);
          assert.ok(Number.isFinite(relative) && relative <= tolerances.nativeWasmVolumeRelative,
            `#${expected.id}: native ${expected.volume}, Node/wasm ${actual.volumeM3}`);
        } else {
          assert.equal(actual.parts, undefined, 'refusal cannot include partial geometry');
        }
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});


test('#7955 M4 and M11 committed extrusion OBJ differs from its base golden only in the obligations header and the M11-N corner normals', {
  timeout: 120000,
  skip: !(engine && existsSync(engine)) && 'SKIP: no staged SMLib engine; this is NOT header identity evidence',
}, async () => {
  const { validateEngine } = await import('../../packages/cli/dist/retained/engine.js');
  const { runRetained } = await import('../../packages/cli/dist/retained/run.js');
  const { retainedObj } = await import('../../packages/cli/dist/retained/obj.js');
  const source = await readFile('tests/fixtures/synthetic-retained/f-c-extrusion.ifc');
  const { outcomes } = await runRetained(await validateEngine(engine), source);
  assert.ok(outcomes.length > 0 && outcomes.every(p => p.status === 'published'));
  for (const product of outcomes) {
    assert.deepEqual(product.obligationsUnmet, [], 'M4 and M11 discharge every obligation');
    assert.equal(product.marker, 'final');
    for (const part of product.parts) {
      assert.equal(part.revisionLocalFaces.length, part.indices.length / 3);
      assert.ok(part.normals instanceof Float64Array && part.normals.length === part.indices.length * 3, 'M11-N: one f64 normal per corner');
      assert.equal(part.instanceKey, undefined);
      // M11-F: every triangle carries a persistent source face key.
      assert.equal(part.faces.triangles.length, part.indices.length / 3);
      assert.ok(Array.isArray(part.color) && part.color.length === 4 && (part.geometryItemId === undefined || (Number.isInteger(part.geometryItemId) && part.geometryItemId > 0)), 'M11-A resolved appearance; geometryItemId only for item-bound parts, never 0');
    }
  }
  const previous = (await readFile('tests/fixtures/cli-retained/m11-0-base.obj', 'utf8')).split('\n');
  const written = retainedObj(outcomes).split('\n');
  // M11-N: the writer emits one `vn` per triangle corner and faces reference them as `v//n`.
  // Everything else (vertices, groups, materials, face vertex order) must stay byte-identical.
  const corners = outcomes.flatMap(p => p.parts).reduce((n, part) => n + part.indices.length, 0);
  // OBJ record kind = the first token of the line (parsed output, not a text predicate).
  const kind = line => line.split(' ', 1)[0];
  assert.equal(written.filter(line => kind(line) === 'vn').length, corners, 'exactly one normal per triangle corner');
  let normal = 0;
  const current = written.filter(line => kind(line) !== 'vn').map(line => {
    if (kind(line) !== 'f') return line;
    const refs = line.slice(2).split(' ').map(corner => {
      const [vertex, empty, n] = corner.split('/');
      assert.equal(empty, '', 'face corners are v//n');
      assert.equal(Number(n), ++normal, 'face corners reference their own normal in order');
      return vertex;
    });
    return `f ${refs.join(' ')}`;
  });
  assert.equal(current.length, previous.length, 'no added geometry, groups or materials beyond the corner normals');
  const changed = current.flatMap((line, index) => line === previous[index] ? [] : [index]);
  assert.deepEqual(changed, [3, 4], 'only final publication headers change beyond the corner normals');
  assert.equal(current[3], '# retained final');
  assert.equal(current[4], '# final');
});

test('#7955 M11-A Node/wasm appearance equals the native run bit for bit', {
  timeout: 600000,
  skip: !(engine && existsSync(engine)) && 'SKIP: no staged SMLib engine; this is NOT parity evidence',
}, async () => {
  assert.ok(process.env.IFCLITE_M11A_REFERENCE, 'M11-A native reference is required');
  const reference = JSON.parse(await readFile(process.env.IFCLITE_M11A_REFERENCE, 'utf8'));
  assert.ok(reference.length > 0 && reference.every(model => model.rows.length > 0), 'native observations required');
  const { validateEngine } = await import('../../packages/cli/dist/retained/engine.js');
  const { runRetained } = await import('../../packages/cli/dist/retained/run.js');
  const bits = value => new Uint32Array(Float32Array.of(value).buffer)[0];
  for (const { path, rows } of reference) {
    const { outcomes } = await runRetained(await validateEngine(engine), await readFile(path), Uint32Array.from(rows.map(row => row.id)));
    assert.equal(outcomes.length, rows.length, path);
    for (const row of rows) {
      const actual = outcomes.find(outcome => outcome.expressId === row.id);
      assert.ok(actual, `${path} #${row.id}`);
      assert.equal(actual.status === 'published' ? 'published' : actual.code, row.code, `${path} #${row.id}`);
      if (row.code !== 'published') continue;
      assert.deepEqual(actual.obligationsUnmet.filter(name => name === 'IfcAppearance'), [], `${path} #${row.id}`);
      assert.deepEqual(actual.parts.map(part => ({ rgbaBits: part.color.map(bits), materialName: part.materialName ?? null, geometryItemId: part.geometryItemId ?? null })),
        row.parts, `${path} #${row.id}: Node/wasm appearance differs from native`);
    }
  }
});
