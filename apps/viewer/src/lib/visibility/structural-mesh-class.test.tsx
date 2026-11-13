/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10119: a retype changes an entity's class but not the class its mesh was
 * built with. Every mesh filter must classify the mesh by the entity's class
 * after the retype, the way the structural ID mask does, so a beam retyped to
 * IfcStructuralCurveMember stays drawn in analytical mode and is hidden in
 * physical mode. Checked for the legacy single store and a federated model.
 */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act, useState } from 'react';
import { createSyntheticDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { generateIfcGuid } from '@ifc-lite/encoding';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { StructuralViewMode } from '@/store/types';
import type { FederatedModel } from '@/store';
import { useViewerStore } from '@/store';
import { TYPE_VISIBILITY_SEMANTIC_DEFAULTS } from '@/store/constants';
import { getVisibleBasketEntityRefsFromStore, invalidateVisibleBasketCache } from '@/store/basketVisibleSet';
import { cleanup, render } from '@/test/render';
import { fixtureModel } from '@/test/store-fixture';
import { toGlobalIdFromModels } from '@/store/globalId';
import { useFilteredGeometry } from '@/components/viewer/useFilteredGeometry';
import { useRetypedClasses } from '@/hooks/useViewerSelectors';
import { visibleCutMeshes } from '@/lib/drawing/cut-meshes';
import { collectViewMeshes } from '@/lib/export/view-pdf/collect-view-meshes';
import { readViewPdfSource } from '@/lib/export/view-pdf/view-pdf-export-source';
import { companionHiddenNow } from '@/lib/appearance/companion-preview';
import { resolveViewHiddenEntities, retypedClasses } from './structural-view';

const BEAM = 7, COLUMN = 9, MEMBER = 11;
const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); invalidateVisibleBasketCache(); });

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
function geometry(meshes: MeshData[]): GeometryResult {
  return { meshes, totalTriangles: meshes.length, totalVertices: meshes.length * 3,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
}
const mesh = (expressId: number, ifcType: string): MeshData => ({ expressId, ifcType,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array(9),
  indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] });

/** Seeds the store with a beam, a column and an analytical member, then retypes
 *  the beam in the edited model. Federated: two models, only `b` is edited, so
 *  model `a`'s beam is the control for global-id keying. Returns the beam's
 *  global id, the meshes in render order and the ids each mode must keep. */
function seed(federated: boolean) {
  const store = () => createSyntheticDataStore({ schemaVersion: 'IFC4', fileSize: 0, entities: [
    { expressId: BEAM, type: 'IfcBeam', hasGeometry: true },
    { expressId: COLUMN, type: 'IfcColumn', hasGeometry: true },
    { expressId: MEMBER, type: 'IfcStructuralCurveMember', hasGeometry: true },
  ] });
  const meshesFor = (offset: number) => [mesh(BEAM + offset, 'IfcBeam'), mesh(COLUMN + offset, 'IfcColumn'),
    mesh(MEMBER + offset, 'IfcStructuralCurveMember')];
  const typeVisibility = { ...TYPE_VISIBILITY_SEMANTIC_DEFAULTS };
  if (federated) {
    const models = new Map<string, FederatedModel>(['a', 'b'].map((id, i) => {
      const offset = (i + 1) * 1_000;
      return [id, { ...fixtureModel(id, { idOffset: offset }), ifcDataStore: store(), maxExpressId: MEMBER,
        geometryResult: geometry(meshesFor(offset)) } as FederatedModel];
    }));
    const view = new MutablePropertyView(null, 'b');
    useViewerStore.setState({ models, ifcDataStore: null, geometryResult: null, mutationViews: new Map([['b', view]]), typeVisibility,
      toGlobalId: (modelId: string, id: number) => toGlobalIdFromModels(models, modelId, id) });
    new StoreEditor(models.get('b')!.ifcDataStore!, view).setEntityType(BEAM, 'IfcStructuralCurveMember');
    const meshes = [...meshesFor(1_000), ...meshesFor(2_000)];
    return { beam: 2_000 + BEAM, meshes, view,
      keep: { physical: [1_000 + BEAM, 1_000 + COLUMN, 2_000 + COLUMN], analytical: [1_000 + MEMBER, 2_000 + BEAM, 2_000 + MEMBER] } };
  }
  const legacy = store();
  const view = new MutablePropertyView(null, '__legacy__');
  const meshes = meshesFor(0);
  useViewerStore.setState({ models: new Map(), ifcDataStore: legacy, geometryResult: geometry(meshes),
    mutationViews: new Map([['__legacy__', view]]), typeVisibility });
  new StoreEditor(legacy, view).setEntityType(BEAM, 'IfcStructuralCurveMember');
  return { beam: BEAM, meshes, view, keep: { physical: [COLUMN], analytical: [BEAM, MEMBER] } };
}

const modes = ['physical', 'analytical'] as const;
const ids = (list: readonly { expressId: number }[]) => list.map((m) => m.expressId).sort((x, y) => x - y);

for (const federated of [false, true]) {
  const label = federated ? 'federated' : 'legacy';

  it(`#10119 viewport filter keeps a retyped beam by its class after the retype (${label})`, () => {
    const { meshes, keep } = seed(federated);
    const merged = geometry(meshes);
    let setMode!: (m: StructuralViewMode) => void;
    let seen: number[] = [];
    function Probe() {
      const [mode, set] = useState<StructuralViewMode>('both');
      setMode = set;
      const retyped = useRetypedClasses();
      seen = ids(useFilteredGeometry(merged, 0, useViewerStore.getState().typeVisibility, 'model', mode, retyped).filteredGeometry ?? []);
      return null;
    }
    render(<Probe />);
    for (const mode of modes) {
      act(() => setMode(mode));
      assert.deepEqual(seen, keep[mode], mode);
    }
  });

  it(`#10119 a retype while analytical mode is on refilters the resident meshes (${label})`, () => {
    const { beam, view, meshes } = seed(federated);
    const merged = geometry(meshes);
    let seen: number[] = [];
    function Probe() {
      const retyped = useRetypedClasses();
      seen = ids(useFilteredGeometry(merged, 0, useViewerStore.getState().typeVisibility, 'model', 'analytical', retyped).filteredGeometry ?? []);
      return null;
    }
    render(<Probe />);
    assert.ok(seen.includes(beam));
    const localBeam = federated ? BEAM : beam;
    act(() => {
      view.removeTypeMutation(localBeam);
      useViewerStore.setState((s) => ({ mutationVersion: s.mutationVersion + 1 }));
    });
    assert.ok(!seen.includes(beam), 'reverting the retype drops the beam from analytical mode');
  });

  it(`#10119 cut, PDF, basket and companion filters agree with the mask (${label})`, () => {
    const { beam, meshes, keep } = seed(federated);
    for (const mode of modes) {
      useViewerStore.setState({ structuralViewMode: mode });
      invalidateVisibleBasketCache();
      const state = useViewerStore.getState();
      const hiddenIds = resolveViewHiddenEntities(state);
      assert.equal(hiddenIds.has(beam), mode === 'physical', `mask, ${mode}`);
      const cut = visibleCutMeshes(meshes, { typeVisibility: state.typeVisibility, structuralViewMode: mode,
        retypedClasses: retypedClasses(state), hiddenIds, isolatedIds: null });
      assert.deepEqual(ids(cut), keep[mode], `cut, ${mode}`);
      assert.deepEqual(ids(collectViewMeshes(readViewPdfSource(state).view)), keep[mode], `pdf, ${mode}`);
      const basket = getVisibleBasketEntityRefsFromStore(false, state).map((r) => state.toGlobalId(r.modelId, r.expressId));
      assert.deepEqual(basket.sort((x, y) => x - y), keep[mode], `basket, ${mode}`);
      // Companion previews resolve through the federation; the legacy slot has none.
      if (federated) assert.equal(companionHiddenNow(beam, state), mode === 'physical', `companion, ${mode}`);
    }
  });
}

it('#10119 retypedClasses covers a retyped authored entity and leaves deleted rows out', () => {
  const store = createSyntheticDataStore({ schemaVersion: 'IFC4', fileSize: 0, entities: [
    { expressId: BEAM, type: 'IfcBeam', hasGeometry: true },
    { expressId: COLUMN, type: 'IfcColumn', hasGeometry: true },
  ] });
  const view = new MutablePropertyView(null, '__legacy__');
  const editor = new StoreEditor(store, view);
  const authored = editor.addEntity('IfcBeam', [generateIfcGuid(), null, 'New beam', null, null, null, null, null, null]);
  editor.setEntityType(authored.expressId, 'IfcStructuralCurveMember');
  editor.setEntityType(COLUMN, 'IfcStructuralCurveMember');
  editor.removeEntity(COLUMN);
  const retyped = retypedClasses({ models: new Map(), ifcDataStore: store, mutationViews: new Map([['__legacy__', view]]), toGlobalId: (_m, id) => id });
  assert.deepEqual([...retyped], [[authored.expressId, 'IfcStructuralCurveMember']]);
});
