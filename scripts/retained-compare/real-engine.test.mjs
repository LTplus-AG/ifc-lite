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


test('#7955 M11-0 committed extrusion OBJ differs from its base golden only in the unmet-normals header', {
  timeout: 120000,
  skip: !(engine && existsSync(engine)) && 'SKIP: no staged SMLib engine; this is NOT header identity evidence',
}, async () => {
  const { validateEngine } = await import('../../packages/cli/dist/retained/engine.js');
  const { runRetained } = await import('../../packages/cli/dist/retained/run.js');
  const { retainedObj } = await import('../../packages/cli/dist/retained/obj.js');
  const source = await readFile('tests/fixtures/synthetic-retained/f-c-extrusion.ifc');
  const outcomes = await runRetained(await validateEngine(engine), source);
  assert.ok(outcomes.length > 0 && outcomes.every(p => p.status === 'published'));
  for (const product of outcomes) {
    assert.ok(!product.obligationsUnmet.includes('SurfaceNormals'), 'M11-N discharges surface normals');
    for (const part of product.parts) {
      assert.equal(part.revisionLocalFaces.length, part.indices.length / 3);
      assert.ok(part.normals instanceof Float64Array && part.normals.length === part.indices.length * 3, 'M11-N: one f64 normal per corner');
      for (const key of ['color', 'instanceKey']) assert.equal(part[key], undefined);
      // M11-F: every triangle carries a persistent source face key.
      assert.equal(part.faces.triangles.length, part.indices.length / 3);
    }
  }
  const previous = (await readFile('tests/fixtures/cli-retained/m11-0-base.obj', 'utf8')).split('\n');
  const current = retainedObj(outcomes).split('\n');
  assert.equal(current.length, previous.length, 'no added geometry, normals, groups or materials');
  const changed = current.flatMap((line, index) => line === previous[index] ? [] : [index]);
  assert.deepEqual(changed, [3], 'the ONLY changed line must be the presentation obligations header');
  assert.equal(current[3], previous[3].replace(', PersistentFaces', '') + ', SurfaceNormals', 'M11-F discharges PersistentFaces');
});
