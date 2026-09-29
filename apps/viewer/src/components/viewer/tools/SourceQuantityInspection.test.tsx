/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import type { ExtrusionDefinitions, SweptDiskDescriptions } from '@ifc-lite/geometry';
import type { SelectedExtrusionsState } from '@/hooks/useSelectedExtrusions';
import type { SelectedSweptDisksState } from '@/hooks/useSelectedSweptDisks';
import { SourceQuantityContent } from './SourceQuantityInspection.js';

const prior = useViewerStore.getState();
const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const sourceKey: ExtrusionDefinitions['sources'][number]['key'] = {
  model_sha256: 'fixture', schema: 'IFC4', length_unit_scale_bits: '0',
  context: { kind: 'mapped', representation_map_path: [40] }, solid_id: 80,
};
const definition: ExtrusionDefinitions['sources'][number] = {
  key: sourceKey,
  source: {
    solid_id: 80, SweptArea: null, profile: null, Position: null,
    position_matrix: null, ExtrudedDirection: null, DirectionRatios: null,
    axis_unit_vector: null, Depth: null, status: { type: 'complete' },
  },
  nominal_quantities: {
    profile_area: 1_000_000, projected_height: 2_000, nominal_volume: 2_000_000_000,
  },
};
const instance: ExtrusionDefinitions['instances'][number][number] = {
  ordinal: 0, source: sourceKey, product_id: 31, solid_id: 80,
  mapping_path: [40], source_modified: true,
  world_from_source: null, status: { type: 'complete' },
};
const disk: SweptDiskDescriptions['elements'][string][number] = {
  solid_id: 90, directrix_id: 91, mapping_path: [], source_modified: false,
  Radius: 0.1, InnerRadius: null, Directrix: [], status: { type: 'complete' },
  directrix_metrics: { total_length: 2, segments: [] },
};
afterEach(() => {
  cleanup();
  useViewerStore.setState(prior, true);
});

describe('nominal source quantity readout (#6433)', () => {
  it('shows source provenance from a real buildingSMART extrusion without making a product total', async (context) => {
    useViewerStore.setState({ unitDisplayOverrides: {} });
    const wasm = join(root, 'packages/wasm/pkg/ifc-lite_bg.wasm');
    const wasmJs = join(root, 'packages/wasm/pkg/ifc-lite.js');
    const fixture = join(root, 'tests/models/buildingsmart/annex_e/basic-geometric-shape/extruded-solid.ifc');
    if (!existsSync(wasm) || !existsSync(wasmJs) || !existsSync(fixture)) {
      context.skip('Run pnpm fixtures and build:wasm to test the real IFC source readout');
      return;
    }
    const { initSync, IfcAPI } = await import('@ifc-lite/wasm');
    initSync({ module: readFileSync(wasm) });
    const api = new IfcAPI();
    try {
      const view = api.extrusionDefinitions(readFileSync(fixture));
      const sources = new Map(view.sources.map((source) => [JSON.stringify(source.key), source]));
      const products = Object.entries(view.instances)
        .filter(([, instances]) => instances.some((instance) =>
          sources.get(JSON.stringify(instance.source))?.nominal_quantities));
      assert.ok(products.length > 0, 'real IFC fixture must contain a supported nominal extrusion');
      const [expressId, instances] = products[0];
      const ui = render(<SourceQuantityContent
        disks={{ items: [], loading: false, error: null }}
        extrusions={{ loading: false, error: null, items: [{
          ref: { modelId: 'buildingSMART', expressId: Number(expressId) },
          product: { lengthUnitScale: view.length_unit_scale, diagnostics: [],
            occurrences: instances.map((instance) => ({
              instance, definition: sources.get(JSON.stringify(instance.source)) ?? null,
            })) },
        }] }}
      />);
      const text = ui.textContent ?? '';
      assert.match(text, new RegExp(`IfcExtrudedAreaSolid #${instances[0].solid_id}`));
      assert.match(text, /Nominal source volume: 2 m³/);
      assert.match(text, /not an authored Qto or final product total/);
    } finally {
      api.free();
    }
  });

  it('keeps two mapped source uses separate from each other and from authored/mesh totals', () => {
    useViewerStore.setState({ unitDisplayOverrides: {} });
    const ui = render(<SourceQuantityContent
      disks={{ loading: false, error: null, items: [{
        ref: { modelId: 'm', expressId: 31 }, occurrences: [disk], diagnostics: [],
      }] } satisfies SelectedSweptDisksState}
      extrusions={{ loading: false, error: null, items: [{
        ref: { modelId: 'm', expressId: 31 }, product: {
          lengthUnitScale: 0.001, diagnostics: [],
          occurrences: [0, 1].map(() => ({ instance, definition })),
        },
      }] } satisfies SelectedExtrusionsState}
    />);
    const text = ui.textContent ?? '';
    assert.match(text, /Nominal IFC source geometry/);
    assert.match(text, /IfcSweptDiskSolid #90/);
    assert.equal(text.match(/IfcExtrudedAreaSolid #80/g)?.length, 2);
    assert.equal(text.match(/Nominal source volume: 2 m³/g)?.length, 2);
    assert.match(text, /CSG operand: final geometry differs/);
    assert.match(text, /not an authored Qto or final product total/);
    assert.doesNotMatch(text, /total.*4 m³/i);
  });

  it('marks missing and nonfinite nominal values unavailable instead of showing zero or NaN', () => {
    const ui = render(<SourceQuantityContent
      disks={{ loading: false, error: null, items: [] }}
      extrusions={{ loading: false, error: null, items: [{
        ref: { modelId: 'm', expressId: 31 }, product: {
          lengthUnitScale: 1, diagnostics: [],
          occurrences: [
            { instance: { ...instance, source_modified: false },
              definition: { ...definition, nominal_quantities: null } },
            { instance: { ...instance, solid_id: 81, source_modified: false },
              definition: { ...definition, nominal_quantities: {
                profile_area: Number.POSITIVE_INFINITY, projected_height: 2, nominal_volume: 2,
              } } },
          ],
        },
      }] } satisfies SelectedExtrusionsState}
    />);
    assert.equal((ui.textContent ?? '').match(/unavailable from this source/g)?.length, 2);
    assert.doesNotMatch(ui.textContent ?? '', /NaN|Infinity|0 m³/);
  });

  it('keeps a small positive source volume visibly nonzero (#6433)', () => {
    const ui = render(<SourceQuantityContent
      disks={{ loading: false, error: null, items: [] }}
      extrusions={{ loading: false, error: null, items: [{
        ref: { modelId: 'm', expressId: 31 }, product: {
          lengthUnitScale: 1, diagnostics: [], occurrences: [{
            instance, definition: { ...definition, nominal_quantities: {
              profile_area: 0.01, projected_height: 0.0001, nominal_volume: 0.000001,
            } },
          }],
        },
      }] }}
    />);
    assert.match(ui.textContent ?? '', /Nominal source volume: 1\.000e-6 m³/);
    assert.doesNotMatch(ui.textContent ?? '', /Nominal source volume: 0 m³/);
  });

  it('does not add a source section for one selected product with no supported source', () => {
    const ui = render(<SourceQuantityContent
      disks={{ loading: false, error: null, items: [{
        ref: { modelId: 'm', expressId: 31 }, occurrences: [], diagnostics: [],
      }] }}
      extrusions={{ loading: false, error: null, items: [{
        ref: { modelId: 'm', expressId: 31 }, product: {
          occurrences: [], diagnostics: [], lengthUnitScale: 1,
        },
      }] }}
    />);
    assert.equal(ui.textContent, '');
  });

  it('shows selected unsupported-source diagnostics when no solid occurrence was extracted (#6433)', () => {
    const ui = render(<SourceQuantityContent
      disks={{ loading: false, error: null, items: [{
        ref: { modelId: 'model-a', expressId: 31 }, occurrences: [],
        diagnostics: ['Directrix is not a supported curve'],
      }] }}
      extrusions={{ loading: false, error: null, items: [{
        ref: { modelId: 'model-b', expressId: 42 }, product: {
          occurrences: [], lengthUnitScale: 1,
          diagnostics: ['SweptArea has no supported profile'],
        },
      }] }}
    />);
    assert.match(ui.textContent ?? '', /Nominal IFC source geometry/);
    assert.match(ui.textContent ?? '', /model-a · #31: Directrix is not a supported curve/);
    assert.match(ui.textContent ?? '', /model-b · #42: SweptArea has no supported profile/);
  });

  it('explains unavailable nominal values from unsupported extrusion source and profile statuses (#6433)', () => {
    const profile: NonNullable<ExtrusionDefinitions['sources'][number]['source']['profile']> = {
      profile_id: 71, ifc_type_name: 'IfcArbitraryClosedProfileDef', ProfileType: 'AREA',
      Position: null, profile_position: null, loops: [],
      status: { type: 'unsupported', reason: 'Source curve is unsupported' },
    };
    const ui = render(<SourceQuantityContent
      disks={{ loading: false, error: null, items: [] }}
      extrusions={{ loading: false, error: null, items: [{
        ref: { modelId: 'm', expressId: 31 }, product: {
          lengthUnitScale: 1, diagnostics: [], occurrences: [
            { instance: { ...instance, status: { type: 'complete' } },
              definition: { ...definition, nominal_quantities: null, source: {
                ...definition.source, profile,
                status: { type: 'unsupported', reason: 'Source curve is unsupported' },
              } } },
            { instance: { ...instance, solid_id: 81, status: { type: 'complete' } },
              definition: { ...definition, nominal_quantities: null, source: {
                ...definition.source, profile: { ...profile, status: {
                  type: 'unsupported', reason: 'Profile loop is open',
                } },
              } } },
          ],
        },
      }] }}
    />);
    const text = ui.textContent ?? '';
    assert.equal(text.match(/Nominal source volume: unavailable from this source/g)?.length, 2);
    assert.equal(text.match(/Source curve is unsupported/g)?.length, 1);
    assert.equal(text.match(/Profile loop is open/g)?.length, 1);
  });
});
