/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function transformPoint(matrix, [x, y, z]) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} differs from ${expected}`);
}

/** #6306: exercise the public TypeScript facade over the real WASM extractor. */
export async function runExtrusionBridgeContracts(test, rootDir) {
  const { GeometryProcessor, IfcLiteBridge } = await import(pathToFileURL(join(
    rootDir, 'packages/geometry/dist/index.js',
  )).href);
  const authored = readFileSync(join(
    rootDir, 'rust/geometry/tests/fixtures/issue_098_wall_W.ifc',
  ));
  const synthetic = readFileSync(join(
    rootDir, 'rust/geometry/tests/fixtures/mapped_instances_synthetic.ifc',
  ), 'utf8');
  const millimetreModel = readFileSync(join(
    rootDir, 'rust/geometry/tests/fixtures/nested_mapped_item.ifc',
  ));
  const products = new Uint32Array([928638, 928672]);
  const bridge = new IfcLiteBridge();
  const processor = new GeometryProcessor();
  try {
    test('#6306: processor returns null before initialization', () => {
      assert.equal(processor.extractExtrusionDefinitions(authored, products), null);
    });
    await bridge.init();
    await processor.init();

    for (const [name, extract] of [
      ['IfcLiteBridge', (bytes, ids) => bridge.extractExtrusionDefinitions(bytes, ids)],
      ['GeometryProcessor', (bytes, ids) => processor.extractExtrusionDefinitions(bytes, ids)],
    ]) {
      test(`#6306: ${name} preserves authored Revit extrusion and two mapped placements`, () => {
        const view = extract(authored, products);
        assert.deepEqual(view.diagnostics, []);
        assert.equal(view.up_axis, 'Z');
        assert.equal(view.source_units, 'ifc_file_length_units');
        assert.equal(view.world_units, 'm');
        assert.equal(view.coordinate_space, 'absolute_ifc_world');
        assert.equal(view.length_unit_scale, 1);
        assert.deepEqual(Object.keys(view.instances).sort(), ['928638', '928672']);
        const definition = view.sources.find((item) => item.source.solid_id === 338107);
        assert.ok(definition);
        assert.deepEqual(definition.key.context, {
          kind: 'mapped', representation_map_path: [338168],
        });
        assert.equal(definition.source.Position, 338106);
        assert.equal(definition.source.ExtrudedDirection, 19);
        assert.equal('position_id' in definition.source, false);
        assert.equal('extruded_direction_id' in definition.source, false);
        assert.equal(definition.source.Depth, 0.06);
        assert.equal(definition.source.profile.loops.length, 2);
        assert.equal(definition.source.profile.Position, null);
        assert.equal('position_id' in definition.source.profile, false);
        assert.equal(definition.source.status.type, 'complete');
        // Independently from the IFC profile: outer 2.50 x 0.80 m minus
        // opening 2.41 x 0.71 m, extruded through 0.06 m.
        const nominal = definition.nominal_quantities;
        assert.ok(nominal);
        assert.ok(Math.abs(nominal.profile_area - 0.2889) < 1e-10);
        assert.ok(Math.abs(nominal.nominal_volume - 0.017334) < 1e-10);
        const profile = definition.source.profile;
        const firstEdge = profile.loops[0].segments[0];
        assert.equal(firstEdge.type, 'line');
        firstEdge.start.forEach((value, axis) => near(value, [-1.25, -0.4, 0][axis]));
        const solidPosition = definition.source.position_matrix;
        assert.ok(solidPosition);
        // Reproduce from STEP: first #338090 profile point (-1.25,-0.4,0),
        // solid Position #338106, identity map target #374, then product
        // placements #1953339 / #1953153 for #928638 / #928672. The solid
        // frame rotates Z to +Y, so reversing matrix order changes Z.
        const expectedWorldStart = {
          928638: [1507972.9170178876, 5039550.550037395, 27.64],
          928672: [1507965.598321496, 5039555.253938236, 27.64],
        };
        for (const id of products) {
          const occurrence = view.instances[id].find((item) => item.solid_id === 338107);
          assert.ok(occurrence);
          assert.deepEqual(occurrence.source, definition.key);
          assert.equal(occurrence.mapping_path.length, 1);
          assert.equal(occurrence.world_from_source.length, 16);
          const profilePoint = profile.profile_position
            ? transformPoint(profile.profile_position, firstEdge.start)
            : firstEdge.start;
          const worldPoint = transformPoint(occurrence.world_from_source,
            transformPoint(solidPosition, profilePoint));
          worldPoint.forEach((value, axis) =>
            assert.ok(Math.abs(value - expectedWorldStart[id][axis]) < 1e-6));
        }
      });

      test(`#6306: ${name} distinguishes absent IDs from an empty selection`, () => {
        assert.deepEqual(Object.keys(extract(authored, new Uint32Array()).instances), []);
        assert.ok(extract(authored).instances[928638]);
      });

      test(`#6306: ${name} retains millimetre source values while placing nested maps in metres`, () => {
        const view = extract(millimetreModel, new Uint32Array([35]));
        near(view.length_unit_scale, 0.001);
        const source = view.sources.find((item) => item.source.solid_id === 12);
        assert.ok(source);
        assert.equal(source.source.Position, 11);
        assert.equal(source.source.ExtrudedDirection, 9);
        assert.equal(source.source.profile.Position, 7);
        assert.equal(source.source.Depth, 1000);
        const occurrence = view.instances[35].find((item) => item.solid_id === 12);
        assert.ok(occurrence);
        const placement = occurrence.world_from_source;
        assert.ok(placement);
        near(placement[0], 0.002); // nested map scale 2 x file-unit scale 0.001
        near(placement[12], 10); // nested map's +10000 mm X
        near(placement[13], 5); // outer map's +5000 mm Y
        const solidPosition = source.source.position_matrix;
        assert.ok(solidPosition);
        const atOrigin = transformPoint(placement, transformPoint(solidPosition, [0, 0, 0]));
        atOrigin.forEach((value, axis) => near(value, [11, 6, 0][axis]));
      });

      test(`#6306: ${name} reports an unsupported tapered profile explicitly`, () => {
        const tapered = synthetic.replace(
          '#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,1.0);',
          '#12=IFCEXTRUDEDAREASOLIDTAPERED(#8,#11,#9,1.0,#8);',
        );
        const view = extract(new TextEncoder().encode(tapered), new Uint32Array([31]));
        assert.equal(view.sources[0].source.status.type, 'unsupported');
        assert.match(view.sources[0].source.status.reason, /tapered/i);
        assert.equal(view.sources[0].nominal_quantities, null);
      });
    }
  } finally {
    processor.dispose();
    bridge.dispose();
  }
}
