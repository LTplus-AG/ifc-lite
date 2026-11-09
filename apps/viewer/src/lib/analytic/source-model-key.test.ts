/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shallow } from 'zustand/vanilla/shallow';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore, type FederatedModel, type ViewerState } from '@/store/index.js';
import { modelFieldPatch } from '@/store/slices/modelSlice.visibility.js';
import { selectedSweptDiskProducts, type SelectedSweptDisk } from '@/hooks/useSelectedSweptDisks.js';
import * as centrelineLines from './selected-centreline-lines.js';
import { selectedCentrelineSnapCurves } from './selected-centreline-snaps.js';
import { SOURCE_MODEL_FIELDS, selectedModelVisibility, sourceModelFrame } from './source-model-key.js';

const OFFSET = 1_000_000;
const zero = { x: 0, y: 0, z: 0 };
const box = { min: zero, max: zero };
const coordinateInfo = () => ({ originShift: zero, wasmRtcOffset: zero, hasLargeCoordinates: false,
  originalBounds: box, shiftedBounds: box });

/** A model with every field the centreline paths can read, and a row's UI fields. */
function sourceModel(id: string, idOffset: number): FederatedModel {
  const model = fixtureModel(id, { idOffset });
  Object.assign(model.ifcDataStore!, { source: { byteLength: 1 }, schemaVersion: 'IFC4' });
  return Object.assign(model, {
    maxExpressId: 3, schemaVersion: 'IFC4', loadFormat: 'ifc', loadedAt: 1, collapsed: false,
    geometryResult: { meshes: [], totalVertices: 0, totalTriangles: 0, coordinateInfo: coordinateInfo() },
    preAlignment: { coordinateInfo: coordinateInfo() },
  }) as FederatedModel;
}

const item = (modelId: string): SelectedSweptDisk => ({
  ref: { modelId, expressId: 1 }, diagnostics: [], occurrences: [{
    solid_id: 9, directrix_id: 10, mapping_path: [], source_modified: false,
    Radius: 0.01, InnerRadius: null, status: { type: 'complete' },
    directrix_metrics: { total_length: 1, segments: [{ segment_index: 0, length: 1, bend_angle: null }] },
    Directrix: [{ type: 'line', start: [0, 0, 0], end: [1, 0, 0] }],
  }],
} as SelectedSweptDisk);

let prior: ViewerState;
beforeEach(() => { prior = useViewerStore.getState(); });
afterEach(() => { useViewerStore.setState(prior); });

function seed(...models: FederatedModel[]): void {
  useViewerStore.setState({ ...fixtureModels(...models),
    toGlobalId: (modelId, expressId) => (modelId === 'live' ? OFFSET : 2 * OFFSET) + expressId,
    selectedEntitiesSet: new Set(['live:1']), selectedEntity: { modelId: 'live', expressId: 1 },
    selectedEntityIds: new Set([OFFSET + 1]), selectedEntityId: OFFSET + 1 });
}

describe('source model key (#9158)', () => {
  it('lists every model field the query, the centreline, its snap curves and the anchor read', async () => {
    const reads = new Map<string, Set<string>>();
    const all = new Set<string>();
    const recorded = (model: FederatedModel) => new Proxy(model, { get(object, field, receiver) {
      if (typeof field === 'string') reads.get(object.id)?.add(field);
      return Reflect.get(object, field, receiver);
    } });
    const reference = { spatialReference: { horizontal: {}, vertical: {} }, coordinateInfo: coordinateInfo() };
    for (const status of [undefined, 'same-crs', 'reprojected'] as const) {
      for (const alignmentReference of [undefined, reference]) {
        for (const spatialReference of [undefined, { horizontal: {}, vertical: {} }]) {
          const live = Object.assign(sourceModel('live', OFFSET),
            { federationAlignmentStatus: status, spatialReference, alignmentReference }) as FederatedModel;
          // The other model, loaded later, is the anchor candidate the search compares by load order.
          const other = Object.assign(sourceModel('other', 2 * OFFSET), { loadedAt: 2, spatialReference });
          seed(recorded(live), recorded(other as FederatedModel));
          reads.set('live', new Set()).set('other', new Set());
          const state = useViewerStore.getState();
          selectedSweptDiskProducts(state);
          selectedModelVisibility(state);
          await centrelineLines.selectedCentrelineWorldLines([item('live')], state);
          await selectedCentrelineSnapCurves([item('live')], state, null, undefined, () => undefined);
          assert.ok(reads.get('live')!.size > 0, 'the paths read the recorded models');
          // The frame keys only the selection's models unless one maps through the anchor picked now (#9229).
          assert.equal(typeof centrelineLines.readsLiveAnchor, 'function', 'the lines module says which models read the live anchor');
          if (!centrelineLines.readsLiveAnchor(live)) {
            assert.deepEqual([...reads.get('other')!], [], `${status} ${alignmentReference ? 'recorded' : 'unrecorded'}: a model the selection doesn't reach is never read`);
          }
          for (const fields of reads.values()) for (const field of fields) all.add(field);
        }
      }
    }
    const listed = new Set<string>([...SOURCE_MODEL_FIELDS, 'visible']);
    assert.deepEqual([...all].filter((field) => !listed.has(field)), [],
      'a field the curves read but the key ignores would let its change skip the rebuild');
    for (const field of ['geometryResult', 'preAlignment', 'federationAlignmentStatus', 'alignmentReference', 'ifcDataStore',
      'visible', 'spatialReference', 'loadedAt']) {
      assert.ok(all.has(field), `the fixture exercises the path that reads ${field}; it read ${[...all].join(', ')}`);
    }
  });

  it('keeps its key across a model row\'s UI fields and changes it for each listed field', () => {
    const models = fixtureModels(sourceModel('live', OFFSET)).models;
    const frame = (next: ViewerState['models']) => sourceModelFrame({ ...useViewerStore.getState(), models: next }, ['live']);
    const key = frame(models);
    for (const fields of [{ name: 'renamed' }, { collapsed: true }, { visible: false }]) {
      const next = modelFieldPatch({ models } as ViewerState, 'live', fields).models!;
      assert.notEqual(next, models, 'the store hands over a new Map');
      assert.ok(shallow(frame(next), key), `${Object.keys(fields)[0]} leaves the frame`);
    }
    for (const field of SOURCE_MODEL_FIELDS) {
      const model = models.get('live')!;
      const next = new Map([['live', { ...model, [field]: field === 'id' ? 'moved' : {} } as FederatedModel]]);
      assert.ok(!shallow(frame(next), key), `${field} changes the frame`);
    }
    // Alignment and placement replace these on the kept objects.
    const kept = models.get('live')!;
    let last = key;
    const replaced = (label: string) => {
      const next = frame(new Map(models));
      assert.ok(!shallow(next, last), label);
      last = next;
    };
    kept.geometryResult!.coordinateInfo = coordinateInfo();
    replaced('a frame replaced on the kept geometry object');
    kept.preAlignment!.coordinateInfo = coordinateInfo();
    replaced('a source frame replaced on the kept pre-alignment snapshot');
    Object.assign(kept.ifcDataStore!, { source: { byteLength: 2 } });
    replaced('a source replaced on the kept data store');
    assert.ok(!shallow(frame(new Map([['other', sourceModel('other', 2 * OFFSET)]])), key), 'an unloaded model');
  });

  it('reads the visibility of the models the selection reaches only', () => {
    seed(sourceModel('live', OFFSET), sourceModel('other', 2 * OFFSET));
    const key = selectedModelVisibility(useViewerStore.getState());
    assert.deepEqual(key, ['live', true]);
    useViewerStore.setState((state) => modelFieldPatch(state, 'other', { visible: false }));
    assert.deepEqual(selectedModelVisibility(useViewerStore.getState()), key, 'other holds no selected product');
    useViewerStore.setState((state) => modelFieldPatch(state, 'live', { visible: false }));
    assert.deepEqual(selectedModelVisibility(useViewerStore.getState()), ['live', false]);
  });
});
