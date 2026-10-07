/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Create, mounted (#6894), on the canonical load path: with an IFC model the
 * button creates the accepted proposals as one undo step and they show as
 * Created; an undo makes them creatable again. Without an IFC model the bar
 * offers a blank one, loaded through the same loader.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { skip, blankFile, load } from '@/test/blank-ifc-loader-harness.js';
import { scanRoomSample } from '@/test/scan-room-fixture';
import { waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import { runScanDetectJob } from '@/lib/scan-to-bim/detect-job';
import type { ScanDetectionRun } from '@/store/slices/scanDetectionSlice';
import type { DetectionDeps } from '@/lib/scan-to-bim/run-detection';
import { ScanCreateBar } from './ScanCreateBar';
import { ScanProposalReview } from './ScanProposalReview';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';

const SWAP = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];

function seedRun(targetModelId: string | null): ScanDetectionRun {
  const positions = scanRoomSample();
  const result = runScanDetectJob({ positions, count: positions.length / 3, region: null, scanToModel: SWAP, schema: 'IFC4' });
  const scan = { id: 'scan', name: 'room.e57', visible: true, idOffset: 0, maxExpressId: 0, pointCloudHandleId: 3 } as unknown as FederatedModel;
  const models = new Map(useViewerStore.getState().models);
  models.set('scan', scan);
  useViewerStore.setState({ models });
  const run: ScanDetectionRun = { sourceModelId: 'scan', targetModelId, cropped: false, pointCount: positions.length / 3, cloudMatrix: null, scanToModel: SWAP, result };
  useViewerStore.getState().finishScanDetection(run);
  return run;
}

/** The renderer's view of the scan: unmoved (no matrix) unless a test moves it. */
const unmoved: DetectionDeps = { detector: () => { throw new Error('no detection here'); }, cloudMatrix: () => null };

async function mount(run: ScanDetectionRun, deps: DetectionDeps = unmoved): Promise<{ root: HTMLElement; unmount: () => Promise<void> }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<><ScanProposalReview run={run} /><ScanCreateBar run={run} deps={deps} /></>));
  return { root: host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

const button = (root: HTMLElement, text: RegExp) => [...root.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''));

describe('ScanCreateBar (#6894)', () => {
  it('creates the accepted proposals as one undo step; they show as Created until undone', { skip }, async () => {
    const primary = await load(blankFile('METRE'));
    const run = seedRun(primary.id);
    const proposals = run.result.proposals.proposals;
    const walls = proposals.filter((p) => p.ifcClass === 'IfcWall').map((p) => p.id);
    useViewerStore.getState().decideScanProposals(walls, 'accepted');
    const ui = await mount(run);
    const create = button(ui.root, /^Create 4 accepted elements in /)!;
    assert.ok(create && !create.disabled);
    await act(async () => create.click());
    assert.match(ui.root.textContent ?? '', /4 elements created in .*, one undo step\./);
    assert.equal(ui.root.querySelectorAll('li .bg-teal-600').length, 4, 'the four walls show as Created');
    assert.equal(button(ui.root, /^Create accepted elements$/)?.disabled, true, 'nothing left to create');
    await act(async () => useViewerStore.getState().undo(primary.id));
    assert.equal(ui.root.querySelectorAll('li .bg-teal-600').length, 0, 'undone: no longer created');
    assert.ok(button(ui.root, /^Create 4 accepted elements in /), 'and creatable again');
    await ui.unmount();
  });

  it('says why when editing is off, and creates nothing', { skip }, async () => {
    const primary = await load(blankFile('METRE'));
    const run = seedRun(primary.id);
    useViewerStore.getState().decideScanProposals([run.result.proposals.proposals[0].id], 'accepted');
    useViewerStore.getState().setEditEnabled(false);
    const ui = await mount(run);
    assert.equal(button(ui.root, /^Create 1 accepted element in /)?.disabled, true);
    assert.match(ui.root.textContent ?? '', /Edit/);
    await ui.unmount();
  });

  it('refuses to create once the scan has moved since detection, and creates nothing', { skip }, async () => {
    const primary = await load(blankFile('METRE'));
    const run = seedRun(primary.id);
    useViewerStore.getState().decideScanProposals([run.result.proposals.proposals[0].id], 'accepted');
    // The scan was placed 2 m east after detection: its proposals no longer sit on it.
    const moved: DetectionDeps = { ...unmoved, cloudMatrix: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1] };
    const before = useViewerStore.getState().undoStacks.get(primary.id)?.length ?? 0;
    const ui = await mount(run, moved);
    await act(async () => button(ui.root, /^Create 1 accepted element in /)!.click());
    assert.match(ui.root.textContent ?? '', /The scan has moved since it was detected/);
    assert.equal(useViewerStore.getState().undoStacks.get(primary.id)?.length ?? 0, before, 'nothing was written');
    assert.equal(ui.root.querySelectorAll('li .bg-teal-600').length, 0);
    await ui.unmount();
  });

  it('creates only accepted proposals the filter shows, and says how many accepted ones it leaves out', { skip }, async () => {
    const primary = await load(blankFile('METRE'));
    const run = seedRun(primary.id);
    const proposals = run.result.proposals.proposals;
    useViewerStore.getState().decideScanProposals(proposals.filter((p) => p.ifcClass !== 'IfcColumn').map((p) => p.id), 'accepted');
    // Accept all shown, then narrow the filter to walls: the slabs are hidden.
    useViewerStore.getState().setScanProposalFilter({ classes: ['IfcWall'] });
    const ui = await mount(run);
    assert.match(ui.root.textContent ?? '', /2 accepted proposals are hidden by the filter and will not be created/);
    await act(async () => button(ui.root, /^Create 4 accepted elements in /)!.click());
    const view = useViewerStore.getState().mutationViews.get(primary.id)!;
    const created = Object.values(useViewerStore.getState().scanProposalCreated).map((r) => view.getNewEntity(r.expressId)!.type.toUpperCase());
    assert.deepEqual(created, ['IFCWALL', 'IFCWALL', 'IFCWALL', 'IFCWALL'], 'no hidden slab was created');
    await ui.unmount();
  });

  it('after Detect again, warns before creating what this scan already created in the model', { skip }, async () => {
    const primary = await load(blankFile('METRE'));
    const first = seedRun(primary.id);
    const walls = (run: ScanDetectionRun) => run.result.proposals.proposals.filter((p) => p.ifcClass === 'IfcWall').map((p) => p.id);
    useViewerStore.getState().decideScanProposals(walls(first), 'accepted');
    let ui = await mount(first);
    await act(async () => button(ui.root, /^Create 4 accepted elements in /)!.click());
    assert.doesNotMatch(ui.root.textContent ?? '', /may duplicate/);
    await ui.unmount();
    // Detect again: a fresh run of the same scan, nothing marked created in it.
    const second = seedRun(primary.id);
    useViewerStore.getState().decideScanProposals(walls(second), 'accepted');
    ui = await mount(second);
    assert.match(ui.root.textContent ?? '', /4 elements created from room\.e57 earlier in this session are in .*; creating again may duplicate them\./);
    // Undoing the earlier creation removes them, and the warning with them.
    await act(async () => useViewerStore.getState().undo(primary.id));
    assert.doesNotMatch(ui.root.textContent ?? '', /may duplicate/);
    await ui.unmount();
  });

  it('created proposals stay Created when the model they were written to is reopened', { skip }, async () => {
    const primary = await load(blankFile('METRE'));
    // Detected before any IFC model was loaded (the blank-model flow): the run outlives a reload.
    const run = seedRun(null);
    const walls = run.result.proposals.proposals.filter((p) => p.ifcClass === 'IfcWall').map((p) => p.id);
    useViewerStore.getState().decideScanProposals(walls, 'accepted');
    let ui = await mount(run);
    await act(async () => button(ui.root, /^Create 4 accepted elements in /)!.click());
    await ui.unmount();
    // Export and reopen: a new model with new express ids; the GlobalIds survive.
    const view = useViewerStore.getState().mutationViews.get(primary.id)!;
    const reopened = await load(new File([editedModelBytes(primary.ifcDataStore!, view).slice()], 'reopened.ifc'), 'reopened');
    // The reload: the original goes, the reopened copy is the target now.
    await act(async () => useViewerStore.getState().removeModel(primary.id));
    useViewerStore.setState({ activeModelId: reopened.id });
    assert.ok(useViewerStore.getState().scanDetectionRun, 'the run survives the reload');
    ui = await mount(run);
    assert.equal(ui.root.querySelectorAll('li .bg-teal-600').length, 4, 'the four walls show as Created in the reopened copy');
    assert.equal(button(ui.root, /^Create accepted elements$/)?.disabled, true, 'nothing is offered for creation again');
    await ui.unmount();
  });

  it('without an IFC model it offers a blank one and loads it through the canonical loader', { skip }, async () => {
    const run = seedRun(null);
    const ui = await mount(run);
    const blank = button(ui.root, /^Create a blank IFC model$/)!;
    assert.ok(blank);
    await act(async () => blank.click());
    await waitFor(() => [...useViewerStore.getState().models.values()].some((m) => m.id !== 'scan' && m.ifcDataStore), 'blank model loaded');
    await waitFor(() => !!button(ui.root, /^Create accepted elements$/), 'the bar now targets the blank model');
    await ui.unmount();
  });
});
