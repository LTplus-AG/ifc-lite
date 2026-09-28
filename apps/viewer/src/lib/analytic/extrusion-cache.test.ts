/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtrusionDefinitions } from '@ifc-lite/geometry';
import { ExtrusionCache } from './extrusion-cache.js';
import type { AnalyticSourceModel } from './swept-disk-cache.js';

const direct = { model_sha256: 'sha', schema: 'IFC4', length_unit_scale_bits: 'bits',
  context: { kind: 'direct' as const, representation_id: 20 }, solid_id: 5 };
const mapped = { ...direct, context: { kind: 'mapped' as const, representation_map_path: [30, 31] } };
const source = { solid_id: 5, SweptArea: null, profile: null, Position: null,
  position_matrix: null, ExtrudedDirection: null, DirectionRatios: null,
  axis_unit_vector: null, Depth: null, status: { type: 'unsupported' as const, reason: 'profile unavailable' } };
const instance = (key: typeof direct | typeof mapped, ordinal: number) => ({
  ordinal, source: key, product_id: 7, solid_id: 5, mapping_path: ordinal ? [30, 31] : [],
  source_modified: ordinal > 0, world_from_source: null,
  status: { type: 'unsupported' as const, reason: 'source transform unavailable' },
});

class ControlledCache extends ExtrusionCache {
  calls = 0;
  protected override async extract(_model: AnalyticSourceModel, ids: readonly number[]): Promise<ExtrusionDefinitions> {
    this.calls++;
    assert.deepEqual(ids, [7]);
    return {
      up_axis: 'Z', source_units: 'ifc_file_length_units', world_units: 'm',
      coordinate_space: 'absolute_ifc_world', model_sha256: 'sha', schema: 'IFC4',
      length_unit_scale: 0.001,
      sources: [{ key: direct, source, nominal_quantities: null },
        { key: mapped, source: { ...source, solid_id: 5 }, nominal_quantities: null }],
      instances: { 7: [instance(direct, 0), instance(mapped, 1)] },
      diagnostics: ['product #7, solid #5: unsupported source', 'product #70: unrelated'],
    };
  }
}

it('keeps direct and mapped extrusion occurrences distinct by full source key (#6432)', async () => {
  const cache = new ControlledCache();
  const release = cache.retain();
  const model: AnalyticSourceModel = { id: 'federated-A', ifcDataStore: null,
    sourceFile: new File(['ISO-10303-21'], 'model.ifc') };
  try {
    const result = (await cache.get(model, [7])).get(7);
    assert.ok(result);
    assert.equal(result.lengthUnitScale, 0.001);
    assert.deepEqual(result.occurrences.map(({ definition }) => definition?.key.context.kind), ['direct', 'mapped']);
    assert.deepEqual(result.occurrences.map(({ instance: item }) => item.source_modified), [false, true]);
    assert.deepEqual(result.diagnostics, ['product #7, solid #5: unsupported source']);
    await cache.get(model, [7]);
    assert.equal(cache.calls, 1, 'repeat inspection reuses the retained source result');
  } finally { release(); }
});

it('discards cached products after the model source changes (#6432)', async () => {
  const cache = new ControlledCache();
  const release = cache.retain();
  const sourceFile = new File(['old'], 'old.ifc');
  const model: AnalyticSourceModel = { id: 'federated-A', ifcDataStore: null, sourceFile };
  try {
    await cache.get(model, [7]);
    model.sourceFile = new File(['new'], 'new.ifc');
    cache.prune([model]);
    await cache.get(model, [7]);
    assert.equal(cache.calls, 2);
  } finally { release(); }
});

const authoredFixture = new URL('../../../../../tests/models/buildingsmart/annex_e/basic-geometric-shape/extruded-solid.ifc', import.meta.url);
const wasmBinary = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);

it('reads the exact authored extrusion from a buildingSMART IFC fixture (#6432)', {
  skip: !existsSync(authoredFixture) || !existsSync(wasmBinary)
    ? 'Run pnpm fixtures and pnpm build:wasm for the buildingSMART extrusion source fixture' : false,
}, async () => {
  const cache = new ExtrusionCache();
  const release = cache.retain();
  try {
    const bytes = new Uint8Array(readFileSync(authoredFixture));
    const model: AnalyticSourceModel = { id: 'buildingSMART', ifcDataStore: null,
      sourceFile: new File([bytes], 'extruded-solid.ifc') };
    const product = (await cache.get(model, [1000])).get(1000);
    assert.ok(product);
    assert.equal(product.lengthUnitScale, 0.001);
    assert.equal(product.occurrences.length, 1);
    const { instance: occurrence, definition } = product.occurrences[0];
    assert.equal(occurrence.solid_id, 1021);
    assert.equal(occurrence.status.type, 'complete');
    assert.ok(definition);
    assert.equal(definition.source.Depth, 2000);
    assert.equal(definition.source.profile?.profile_id, 1022);
    assert.ok(definition.source.profile?.loops.length);
  } finally { release(); }
});
