/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * File > Export > GLB on a session-authored model, end to end against the real
 * engine. Nothing is mocked but the browser's save: the blank file loads through
 * the canonical loader, elements go through the store's authoring actions, the
 * dialog is clicked, and the GLB it wrote is opened and read back.
 *
 * The dialog's source-bytes path re-meshed the file as it was loaded, so a Start
 * blank session had nothing to export ("produced 0 meshes") and a loaded model
 * silently lost every edit of the session, while its IFC and USD exports kept them.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { IfcCreator } from '@ifc-lite/create';
import { skip, blankFile, load, bounds, wallMeshes } from '@/test/blank-ifc-loader-harness.js';
import '@/test/download-capture';
import { render, cleanup, click, waitFor, advance } from '@/test/render';
import { useViewerStore } from '@/store';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records.js';
import { addCurtainWallIn } from '@/store/slices/mutation-curtain-grid.js';
import { toGlobalIdFromModels } from '@/store/globalId.js';
import { requestRemesh } from '@/lib/remesh/remesh-service.js';
import { GLBExportDialog } from './GLBExportDialog';
import { readGlb, worldBounds } from './glb-read.test-support';

function elementId(result: { expressId: number } | { error: string }): number {
  assert.ok('expressId' in result, 'error' in result ? result.error : 'element must be created');
  return result.expressId;
}

/** The elements of #9026's run: slab, column, beam, wall, curtain wall, roof. */
async function authorBuilding(modelId: string) {
  const state = useViewerStore.getState();
  const storey = state.models.get(modelId)?.ifcDataStore?.entityIndex.byType.get('IFCBUILDINGSTOREY')?.[0];
  assert.ok(storey, 'the blank file has a storey');
  assert.ok(modelEditTarget(state, modelId), 'the canonical modelling command opens its mutation view');
  const slab = elementId(state.addSlab(modelId, storey, { Position: [0, 0, 0], Width: 6, Depth: 4, Thickness: 0.25 }));
  const column = elementId(state.addColumn(modelId, storey, { Position: [1, 1, 0], Width: 0.3, Depth: 0.4, Height: 3 }));
  const beam = elementId(state.addBeam(modelId, storey, { Start: [0, 2, 3], End: [6, 2, 3], Width: 0.2, Height: 0.3 }));
  const wall = elementId(state.addWall(modelId, storey, { Start: [2, 3, 0], End: [6, 3, 0], Thickness: 0.2, Height: 3 }));
  const roof = elementId(state.addRoof(modelId, storey, { Position: [0, 0, 3.3], Width: 6, Depth: 4, Thickness: 0.25 }));
  const curtain = addCurtainWallIn(useViewerStore, modelId, storey, { Start: [0, 0, 0], End: [6, 0, 0], Height: 3 });
  assert.ok('expressId' in curtain, 'error' in curtain ? curtain.error : 'curtain wall must be created');
  const solids = [slab, column, beam, wall, roof];
  const outcome = await requestRemesh(useViewerStore.getState, modelId, [...solids, ...curtain.partIds], 'created');
  assert.equal(outcome.status, 'applied');
  return { wall, column, solids, partIds: curtain.partIds, panels: curtain.build.panelIds.length };
}

/** Click through the dialog at its defaults and return the bytes it saved. */
async function exportGlbThroughDialog(options: { visibleOnly?: boolean } = {}): Promise<{ bytes: Uint8Array | null; text: string }> {
  let saved: Blob | null = null;
  mock.method(URL, 'createObjectURL', (blob: Blob) => { saved = blob; return 'blob:ifc-lite-test-glb'; });
  render(<GLBExportDialog surface="ribbon" />);
  const button = (label: string) => {
    const found = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
    assert.ok(found, `button "${label}"`);
    return found;
  };
  click(button('Export GLB'));
  await advance(1);
  if (options.visibleOnly) {
    const toggle = [...document.querySelectorAll('[role="switch"]')][0];
    assert.ok(toggle instanceof HTMLElement, 'the Visible Only switch');
    click(toggle);
    await advance(1);
  }
  click(button('Export'));
  await waitFor(() => saved !== null || /produced 0 meshes|GLB export failed/i.test(document.body.textContent ?? ''),
    'the export finished neither with a file nor a refusal');
  const text = document.body.textContent ?? '';
  const blob = saved as Blob | null;
  const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  cleanup();
  return { bytes, text };
}

describe('GLB export of an authored session (#9026 item 18)', () => {
  it('Start blank then author: the file holds every authored element, as authored', { skip }, async () => {
    const model = await load(blankFile('METRE'));
    const { wall, solids, partIds, panels } = await authorBuilding(model.id);

    const { bytes, text } = await exportGlbThroughDialog();
    assert.ok(bytes, `no file was written: ${text}`);
    const glb = readGlb(bytes);

    const expected = [...solids, ...partIds].sort((a, b) => a - b);
    assert.deepEqual([...glb.expressIds].sort((a, b) => a - b), expected, 'one mesh node per authored solid and curtain wall part');
    assert.ok(glb.meshCount > 0 && glb.meshCount <= expected.length, `${glb.meshCount} glTF meshes`);

    // Metadata reads as the same element the session authored, not a bare id.
    const wallNode = glb.nodes.find((node) => node.expressId === wall);
    assert.equal(wallNode?.ifcType, 'IfcWall');
    assert.match(wallNode?.globalId ?? '', /^[0-9A-Za-z_$]{22}$/);
    assert.equal(glb.nodes.filter((node) => node.ifcType === 'IfcPlate').length, panels, 'curtain wall panels');
    assert.equal(glb.nodes.filter((node) => node.ifcType === 'IfcMember').length, partIds.length - panels, 'curtain wall mullions and transoms');

    // Where it was authored: IFC [2,2.9,0]..[6,3.1,3] is glTF Y-up, -Z north.
    const measured = worldBounds(glb, wall);
    const near = (actual: number[], want: number[]) => actual.forEach((value, i) => assert.ok(Math.abs(value - want[i]) < 1e-4, `${actual} vs ${want}`));
    near(measured.min, [2, 0, -3.1]);
    near(measured.max, [6, 3, -2.9]);
    // The GLB and the viewport agree about this element.
    const held = bounds(wallMeshes(model.id, wall));
    near(held.min, [2, 2.9, 0]);
    near(held.max, [6, 3.1, 3]);
  });

  it('Visible only applies to authored elements too', { skip }, async () => {
    const model = await load(blankFile('METRE'));
    const { wall, column, solids, partIds } = await authorBuilding(model.id);
    const state = useViewerStore.getState();
    useViewerStore.setState({ hiddenEntities: new Set([toGlobalIdFromModels(state.models, model.id, wall)]) });

    const { bytes, text } = await exportGlbThroughDialog({ visibleOnly: true });
    assert.ok(bytes, `no file was written: ${text}`);
    const { expressIds } = readGlb(bytes);
    assert.ok(!expressIds.has(wall), 'the hidden authored wall stays out');
    assert.ok(expressIds.has(column), 'its visible neighbours stay in');
    assert.equal(expressIds.size, solids.length + partIds.length - 1);
  });

  it('a loaded model keeps its edits: a deleted wall leaves and an authored one arrives', { skip }, async () => {
    const creator = new IfcCreator({ Name: 'Loaded' });
    const storeyId = creator.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 0 });
    const kept = creator.addIfcWall(storeyId, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    const gone = creator.addIfcWall(storeyId, { Start: [0, 2, 0], End: [4, 2, 0], Thickness: 0.2, Height: 3 });
    const model = await load(new File([creator.toIfc().content], 'loaded.ifc', { type: 'application/ifc' }));

    const clean = await exportGlbThroughDialog();
    assert.ok(clean.bytes, `no file was written: ${clean.text}`);
    assert.deepEqual([...readGlb(clean.bytes).expressIds].sort((a, b) => a - b), [kept, gone], 'an unedited model exports its file');

    const state = useViewerStore.getState();
    const storey = state.models.get(model.id)?.ifcDataStore?.entityIndex.byType.get('IFCBUILDINGSTOREY')?.[0];
    assert.ok(storey);
    assert.ok(modelEditTarget(state, model.id));
    const added = elementId(state.addColumn(model.id, storey, { Position: [1, 1, 0], Width: 0.3, Depth: 0.3, Height: 3 }));
    await requestRemesh(useViewerStore.getState, model.id, [added], 'created');
    assert.ok(useViewerStore.getState().removeEntity(model.id, gone), 'the file wall is deleted in the session');

    const edited = await exportGlbThroughDialog();
    assert.ok(edited.bytes, `no file was written: ${edited.text}`);
    assert.deepEqual([...readGlb(edited.bytes).expressIds].sort((a, b) => a - b), [kept, added].sort((a, b) => a - b));
  });

  it('a federated model takes the held meshes, and those hold what it authored', { skip }, async () => {
    await load(blankFile('METRE'));
    const peer = await load(blankFile('METRE'), 'peer');
    assert.ok(peer.idOffset > 0, 'the federated model is off the primary id space');
    const { solids, partIds } = await authorBuilding(peer.id);
    // The dialog's first model is the primary; pick the peer the way a user does.
    useViewerStore.setState({ models: new Map([[peer.id, useViewerStore.getState().models.get(peer.id)!]]) });

    const { bytes, text } = await exportGlbThroughDialog();
    assert.ok(bytes, `no file was written: ${text}`);
    assert.equal(readGlb(bytes).expressIds.size, solids.length + partIds.length);
  });
});
