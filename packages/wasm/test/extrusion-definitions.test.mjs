/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const rootDir = join(packageDir, '..', '..');
const wasmPath = join(packageDir, 'pkg', 'ifc-lite_bg.wasm');
const wasmJsPath = join(packageDir, 'pkg', 'ifc-lite.js');
const fixture = join(rootDir, 'rust', 'geometry', 'tests', 'fixtures',
  'mapped_instances_synthetic.ifc');
const revitFixture = join(rootDir, 'rust', 'geometry', 'tests', 'fixtures',
  'issue_098_wall_W.ifc');

it('issue #5784 exposes one exact mapped extrusion source with two placed instances', async (t) => {
  if (!existsSync(wasmPath) || !existsSync(wasmJsPath)) {
    t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first');
    return;
  }
  const { initSync, IfcAPI } = await import(wasmJsPath);
  initSync(readFileSync(wasmPath));
  const api = new IfcAPI();
  try {
    const view = api.extrusionDefinitions(readFileSync(fixture), new Uint32Array([31, 38]));
    assert.deepEqual(view.diagnostics, []);
    assert.equal(view.sources.length, 1);
    assert.equal(view.sources[0].source.Depth, 1);
    assert.equal(view.sources[0].source.Position, 11);
    assert.equal(view.sources[0].source.ExtrudedDirection, 9);
    assert.equal(view.sources[0].source.profile.Position, 7);
    assert.equal('position_id' in view.sources[0].source, false);
    assert.equal('extruded_direction_id' in view.sources[0].source, false);
    assert.equal('position_id' in view.sources[0].source.profile, false);
    assert.equal(view.sources[0].source.profile.loops[0].signed_area, 1);
    assert.deepEqual(view.sources[0].nominal_quantities, {
      profile_area: 1, projected_height: 1, nominal_volume: 1,
    });
    assert.deepEqual(view.instances[31][0].source, view.instances[38][0].source);
    assert.equal(view.instances[38][0].world_from_source[12], 3);
    assert.equal(Object.keys(api.extrusionDefinitions(readFileSync(fixture), new Uint32Array()).instances).length, 0);
    const all = api.extrusionDefinitions(readFileSync(fixture));
    assert.ok(all.instances[31] && all.instances[38]);
    assert.ok(Object.keys(all.instances).length > Object.keys(view.instances).length);
    const noPosition = readFileSync(fixture, 'utf8').replace(
      '#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,1.0);',
      '#12=IFCEXTRUDEDAREASOLID(#8,$,#9,1.0);',
    );
    const optional = api.extrusionDefinitions(new TextEncoder().encode(noPosition), new Uint32Array([31]));
    assert.equal(optional.sources[0].source.position_matrix, null);
    const tapered = readFileSync(fixture, 'utf8').replace(
      '#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,1.0);',
      '#12=IFCEXTRUDEDAREASOLIDTAPERED(#8,#11,#9,1.0,#8);',
    );
    assert.equal(api.extrusionDefinitions(new TextEncoder().encode(tapered),
      new Uint32Array([31])).sources[0].nominal_quantities, null);
    const revit = api.extrusionDefinitions(readFileSync(revitFixture),
      new Uint32Array([928638, 928672]));
    const realSource = revit.sources.find(({ source }) => source.solid_id === 338107)?.source;
    assert.ok(realSource, 'real Revit extrusion #338107 must be extracted');
    assert.equal(realSource.Position, 338106);
    assert.equal(realSource.ExtrudedDirection, 19);
    assert.equal('position_id' in realSource, false);
    assert.equal('extruded_direction_id' in realSource, false);
  } finally {
    api.free();
  }
});
