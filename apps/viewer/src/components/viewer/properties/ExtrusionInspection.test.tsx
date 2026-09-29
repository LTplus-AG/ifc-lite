/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtrusionDefinitions } from '@ifc-lite/geometry';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { ExtrusionInspection, ExtrusionRecord } from './ExtrusionInspection.js';

type Definition = ExtrusionDefinitions['sources'][number];
type Instance = ExtrusionDefinitions['instances'][number][number];
const key: Definition['key'] = { model_sha256: 'sha', schema: 'IFC4', length_unit_scale_bits: 'bits',
  context: { kind: 'mapped', representation_map_path: [11] }, solid_id: 30 };
const placement = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
const definition: Definition = {
  key, nominal_quantities: null,
  source: { solid_id: 30, SweptArea: 31, Position: 32, position_matrix: placement(3000),
    ExtrudedDirection: 33, DirectionRatios: [0, 0, 1], axis_unit_vector: [0, 0, 1],
    Depth: 2000, status: { type: 'complete' },
    profile: { profile_id: 31, ifc_type_name: 'IfcArbitraryClosedProfileDef', ProfileType: 'AREA',
      Position: 34, profile_position: placement(1000), status: { type: 'complete' },
      loops: [{ kind: 'outer', signed_area: 2_000_000, perimeter: 6000, segments: [
        { type: 'line', start: [0, 0], end: [2000, 0] },
        { type: 'arc', center: [1000, 1000], normal: [0, 0, 1], x_axis: [1, 0, 0],
          radius: 1000, start_angle: 0, sweep_angle: Math.PI },
      ] }],
    },
  },
};
const instance: Instance = { ordinal: 1, source: key, product_id: 7, solid_id: 30,
  mapping_path: [11, 12], source_modified: true, world_from_source: placement(5_000_000),
  status: { type: 'complete' } };

const prior = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(prior, true); });

it('keeps the properties pane quiet when no extrusion source is selected (#6432)', () => {
  useViewerStore.setState({ selectedEntity: null, selectedEntityId: null,
    selectedEntityIds: new Set(), selectedEntitiesSet: new Set(), models: new Map(), ifcDataStore: null });
  const ui = render(<ExtrusionInspection enabled />);
  assert.equal(ui.querySelector('[aria-label="Authored extrusion sources"]'), null);
});

it('renders authored millimetre profile dimensions as metres and discloses CSG modification (#6432)', () => {
  useViewerStore.setState({ unitDisplayOverrides: {} });
  const ui = render(<ExtrusionRecord instance={instance} definition={definition} lengthUnitScale={0.001} />);
  const text = ui.textContent ?? '';
  assert.match(text, /IfcExtrudedAreaSolid #30/);
  assert.match(text, /IfcArbitraryClosedProfileDef #31/);
  assert.match(text, /#11 → #12/);
  assert.match(text, /Depth: 2 m/);
  assert.match(text, /authored profile may differ from the visible result/);
  const loop = ui.querySelector('details');
  assert.ok(loop);
  assert.match(loop.textContent ?? '', /Perimeter: 6 m/);
  assert.match(loop.textContent ?? '', /Signed area: 2 m²/);
  assert.match(loop.textContent ?? '', /center \[1, 1\] m/);
  const placementDetail = [...ui.querySelectorAll('details')].find((detail) => detail.textContent?.includes('Source placement'));
  assert.ok(placementDetail);
  assert.match(placementDetail.textContent ?? '', /Profile Position frameTranslation: \[1, 0, 0\] m/);
  assert.match(placementDetail.textContent ?? '', /Solid Position frameTranslation: \[3, 0, 0\] m/);
  assert.match(placementDetail.textContent ?? '', /World from source frameTranslation: \[5,?000,?000, 0, 0\] m/);
});

it('reports an unsupported source without inventing profile geometry (#6432)', () => {
  const ui = render(<ExtrusionRecord instance={{ ...instance, status: { type: 'unsupported', reason: 'mapped transform unsupported' } }}
    definition={null} lengthUnitScale={1} />);
  assert.match(ui.textContent ?? '', /Unsupported/);
  assert.match(ui.textContent ?? '', /mapped transform unsupported/);
  assert.match(ui.textContent ?? '', /Source definition is unavailable/);
  assert.equal(ui.querySelectorAll('details').length, 0);
});
