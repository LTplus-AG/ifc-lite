/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Authoring operations write where they say, act on their own model only, and
 * refuse instead of reporting a no-op as done (#10793, rows of #10695).
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { loadStoreyAdapter } from '@/sdk/adapters/store-adapter-storey';
import { createMainViewerToolHost } from '../main-viewer-host';
import { dispatchMainViewerTool, type AgentToolResult } from '../main-viewer-dispatch';
import { viewerOperation } from './registry';
import type { ToolHost } from '../types';
import { BACK_WALL, GROUND_STOREY, SAMPLE_MODEL, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { fixtureModel } from '@/test/store-fixture';
import { resetFeaturesForTest } from '@/lib/features';

const OTHER = 'other';
let host: ToolHost;
async function seed() {
  resetFeaturesForTest(); await seedAuthoringSample(); await loadStoreyAdapter();
  useViewerStore.setState({ zoneSets: [], zoneAssignments: new Map(), selectedEntityIds: new Set(), selectedEntityId: null });
  host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
}
const invoke = (id: string, input: unknown = {}, write = true) => dispatchMainViewerTool(host, write ? 'viewer_operation_execute' : 'viewer_operation_inspect', {
  ...(viewerOperation(id).needs === 'model' ? { model_id: SAMPLE_MODEL } : {}), operation_id: id, input,
}, { canEdit: () => true });
function answer<T>(result: AgentToolResult): T {
  assert.equal(result.isError, false, result.text);
  return JSON.parse((result.structured as { result: { native_json: string } }).result.native_json) as T;
}
const defaults = () => JSON.stringify(useViewerStore.getState().authoringDefaults);
const expressOf = (globalId: string) => useViewerStore.getState().models.get(SAMPLE_MODEL)!.ifcDataStore!.entities.getExpressIdByGlobalId(globalId);
/** A second loaded model with a pending reposition preview of its own. */
function previewOtherModel() {
  const s = useViewerStore.getState();
  useViewerStore.setState({ models: new Map([...s.models, [OTHER, fixtureModel(OTHER)]]) });
  useViewerStore.getState().openReposition([OTHER]); useViewerStore.getState().previewModelTranslation([4, 0, 0]);
  assert.deepEqual(useViewerStore.getState().modelPlacement.preview?.modelIds, [OTHER]);
}

describe('authoring operations write the named target (#10793)', () => {
  beforeEach(seed);

  it('reports a refused native material assignment before marking the write committed (#10871)', async () => {
    const state = useViewerStore.getState();
    const dataStore = state.models.get(SAMPLE_MODEL)!.ifcDataStore!;
    // A Cartesian point exists in the model but cannot receive an IfcRelAssociatesMaterial.
    const express_id = dataStore.entityIndex.byType.get('IFCCARTESIANPOINT')?.[0];
    assert.ok(express_id);
    const view = state.mutationViews.get(SAMPLE_MODEL)!;
    const before = view.getNewEntities().length;
    const result = await invoke('authoring.material.createAndAssign', {
      express_id, Name: 'Concrete', Color: '#808080', Category: '', Description: '',
    });
    const details = result.structured as { reason: string; committed?: boolean };
    assert.equal(result.errorCode, 'INVALID_INPUT', result.text);
    assert.equal(details.reason, 'refused');
    assert.equal(details.committed, undefined);
    assert.equal(view.getNewEntities().length, before, 'native refusal rolls back the new material');
  });

  it('#21 a Rectangle profile writes the kind Width and Height (Depth for a column) that placement reads', async () => {
    answer(await invoke('authoring.defaults.profile', { owner: 'beam', profile_json: JSON.stringify({ Type: 'Rectangle', XDim: 0.25, YDim: 0.6 }), expected_defaults: defaults() }));
    answer(await invoke('authoring.defaults.profile', { owner: 'column', profile_json: JSON.stringify({ Type: 'Rectangle', XDim: 0.5, YDim: 0.7 }), expected_defaults: defaults() }));
    const { dims, profiles } = useViewerStore.getState().authoringDefaults;
    assert.deepEqual([dims.beam.Width, dims.beam.Height, dims.column.Width, dims.column.Depth], [0.25, 0.6, 0.5, 0.7]);
    assert.equal(profiles.beam.type, 'Rectangle');
  });

  it('#51 a zero SillHeight is accepted, a negative one is not', async () => {
    answer(await invoke('authoring.defaults.dimension', { kind: 'window', field: 'SillHeight', metres: 0, expected_defaults: defaults() }));
    assert.equal(useViewerStore.getState().authoringDefaults.dims.window.SillHeight, 0);
    assert.equal((await invoke('authoring.defaults.dimension', { kind: 'window', field: 'SillHeight', metres: -0.1, expected_defaults: defaults() })).isError, true);
    assert.equal((await invoke('authoring.defaults.dimension', { kind: 'window', field: 'Width', metres: 0, expected_defaults: defaults() })).isError, true);
    answer(await invoke('authoring.defaults.dimension', { kind: 'beam', field: 'Bottom', metres: -0.2, expected_defaults: defaults() }));
    assert.equal(useViewerStore.getState().authoringDefaults.dims.beam.Bottom, -0.2, 'a downstand Bottom stays allowed, as in the HUD');
  });

  it('#50 clearing a pick leaves another model\'s pick alone', async () => {
    const pick = { modelId: OTHER, expressId: 7 };
    useViewerStore.getState().setAuthoringDefaults({ typeIds: { wall: pick } });
    assert.equal((await invoke('authoring.defaults.pick', { kind: 'wall', channel: 'type', express_id: 0, expected_defaults: defaults() })).isError, true);
    assert.deepEqual(useViewerStore.getState().authoringDefaults.typeIds.wall, pick);
  });

  it('#25 storeys.prepare plans a storey add on the viewer backend', async () => {
    const prepared = answer<{ token: string; plan: { refusal: unknown } }>(await invoke('storeys.prepare', { kind: 'add', express_id: 0, params_json: JSON.stringify({ Name: 'Level 1', Elevation: 3, referenceStoreyId: expressOf(GROUND_STOREY) }) }));
    assert.ok(prepared.token); assert.equal(prepared.plan.refusal, null);
  });

  it('#26 a storey edit refuses params naming a storey other than express_id', async () => {
    const ground = expressOf(GROUND_STOREY), above = host.models()[0].bim.store.addStorey(SAMPLE_MODEL, { Name: 'Level 1', Elevation: 3, referenceStoreyId: ground });
    const result = await invoke('storeys.prepare', { kind: 'edit', express_id: ground, params_json: JSON.stringify({ kind: 'elevation', storeyId: above.expressId, Elevation: 3.5 }) });
    assert.equal(result.isError, true); assert.match(result.text, /storeyId/);
  });

  it('#27 storeys.topConstraint attaches a wall top through the viewer backend', async () => {
    const above = host.models()[0].bim.store.addStorey(SAMPLE_MODEL, { Name: 'Level 1', Elevation: 3, referenceStoreyId: expressOf(GROUND_STOREY) });
    // The sample's own walls are SketchUp B-reps, which no top edit can resize; author an extruded one.
    const proposal_json = JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Wall', units: 'm', frame: 'storey-local', operations: [
      { op: 'element.create', ref: 'w', ifcClass: 'IfcWall', storey: { globalId: GROUND_STOREY, modelId: SAMPLE_MODEL }, name: 'Top wall', params: { start: [10, 10, 0], end: [14, 10, 0], thickness: 0.2, height: 2.5 } }] });
    const raw = <T>(result: AgentToolResult) => { assert.equal(result.isError, false, result.text); return (result.structured as { result: T }).result; };
    const { token } = raw<{ token: string }>(await invoke('authoring.prepare', { proposal_json }, false));
    const receipt = JSON.parse(raw<{ receipt_json: string }>(await invoke('authoring.apply', { token })).receipt_json) as { applied: Array<{ globalId: string }> };
    const wall = useViewerStore.getState().mutationViews.get(SAMPLE_MODEL)!.getNewEntities().find(row => row.type.toUpperCase() === 'IFCWALL' && row.attributes[0] === receipt.applied[0].globalId)!.expressId, before = useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length ?? 0;
    const refs = answer<Array<{ expressId: number }>>(await invoke('storeys.topConstraint', { express_id: wall, constraint_json: JSON.stringify({ kind: 'storeyAbove' }) }));
    assert.deepEqual(refs.map(ref => ref.expressId), [wall]);
    assert.ok((useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length ?? 0) > before);
    assert.equal(useViewerStore.getState().mutationViews.get(SAMPLE_MODEL)?.getPropertyValue(wall, 'IfcLite_StoreyAttachment', 'TopConstraint'),
      useViewerStore.getState().mutationViews.get(SAMPLE_MODEL)!.getNewEntities().find(row => row.expressId === above.expressId)!.attributes[0], 'the wall top follows the new storey');
  });

  it('#30 rotating this model refuses to commit another model\'s pending move', async () => {
    previewOtherModel(); const revision = useViewerStore.getState().modelPlacement.revision;
    assert.equal((await invoke('placement.rotation', { angle: 0.5, pivot: [0, 0, 0], placement_revision: revision })).isError, true);
    const after = useViewerStore.getState().modelPlacement;
    assert.deepEqual(after.preview?.modelIds, [OTHER]); assert.equal(after.placements.has(OTHER), false);
  });

  it('#60 undo, redo and reset keep another model\'s preview', async () => {
    previewOtherModel();
    for (const action of ['undo', 'redo', 'reset'] as const) {
      const result = await invoke('placement.translation.action', { placement_revision: useViewerStore.getState().modelPlacement.revision, action });
      assert.equal(result.isError, true, action); assert.deepEqual(useViewerStore.getState().modelPlacement.preview?.modelIds, [OTHER], action);
    }
    useViewerStore.getState().closeReposition();
    const empty = await invoke('placement.translation.action', { placement_revision: useViewerStore.getState().modelPlacement.revision, action: 'undo' });
    assert.equal(empty.isError, true); assert.match(empty.text, /Nothing to undo/);
    // This model's own preview is still dropped by an empty-stack undo, as natively.
    useViewerStore.getState().openReposition([SAMPLE_MODEL]); useViewerStore.getState().previewModelTranslation([1, 0, 0]);
    answer(await invoke('placement.translation.action', { placement_revision: useViewerStore.getState().modelPlacement.revision, action: 'undo' }));
    assert.equal(useViewerStore.getState().modelPlacement.preview, null);
  });

  it('#58 a box write to a footprint prism zone is refused', async () => {
    const setId = useViewerStore.getState().createZoneSet('Prisms');
    useViewerStore.getState().addZone(setId, { name: 'P', center: [1, 1, 1], size: [2, 2, 2], rotationY: 0, footprint: [[0, 0], [2, 0], [2, 2], [0, 2]] });
    // The zone token is the configuration_revision zones.read returns (#10794).
    const zone = useViewerStore.getState().zoneSets[0].zones[0], configuration = async () => answer<{ configuration_revision: string }>(await invoke('zones.read', {}, false)).configuration_revision;
    const result = await invoke('zones.box.write', { set_id: setId, zone_id: zone.id, name: 'P', center: [9, 1, 9], size: [5, 2, 5], rotationY: 0, expected_configuration: await configuration() });
    assert.equal(result.isError, true); assert.match(result.text, /footprint prism/); assert.deepEqual(useViewerStore.getState().zoneSets[0].zones[0].center, zone.center);
    // What the prism keeps from a box write (name, vertical centre, height) still applies.
    answer(await invoke('zones.box.write', { set_id: setId, zone_id: zone.id, name: 'Taller', center: [zone.center[0], 2, zone.center[2]], size: [zone.size[0], 4, zone.size[2]], rotationY: zone.rotationY, expected_configuration: await configuration() }));
    const after = useViewerStore.getState().zoneSets[0].zones[0];
    assert.deepEqual([after.name, after.center[1], after.size[1]], ['Taller', 2, 4]); assert.deepEqual(after.footprint, zone.footprint);
  });

  it('#59 zones.select refuses an unknown zone and keeps the user selection', async () => {
    const setId = useViewerStore.getState().createZoneSet('Boxes'), wall = expressOf(BACK_WALL);
    useViewerStore.getState().setSelectedEntityId(wall);
    assert.equal((await invoke('zones.select', { set_id: setId, zone_id: 'missing' })).isError, true);
    assert.equal(useViewerStore.getState().selectedEntityId, wall);
  });

  it('#62 changes.select refuses an entity no current change touched', async () => {
    const result = await invoke('changes.select', { express_id: expressOf(BACK_WALL) });
    assert.equal(result.isError, true); assert.equal(useViewerStore.getState().selectedEntityId, null);
    useViewerStore.getState().setAttribute(SAMPLE_MODEL, expressOf(BACK_WALL), 'Name', 'Changed');
    assert.deepEqual(answer(await invoke('changes.select', { express_id: expressOf(BACK_WALL) })), { selected: true });
  });
});
