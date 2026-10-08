/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The scan-to-BIM review flow, mounted (#6894): Detect elements runs the real
 * detection (wasm, in-process) on a scan held in the scan cache, the review
 * list shows its proposals, and accept / reject, accept all shown and the
 * class and confidence filters drive the store's decisions and the overlay.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render, type, waitFor } from '@/test/render.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { scanRoomSample } from '@/test/scan-room-fixture';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import { addPointsToScanCache, clearAllPointCloudScanCaches, registerPointCloudScanCache } from '@/hooks/ingest/pointCloudScanCache';
import { createScanDetector } from '@/lib/scan-to-bim/scan-detector';
import { detectionOverlayMeshes } from '@/lib/scan-to-bim/detection-overlay';
import type { DetectionDeps } from '@/lib/scan-to-bim/run-detection';
import { ScanDetectionSection } from './ScanDetectionSection';

const HANDLE = 41;
const initial = useViewerStore.getState();

function seed(t: TestContext): DetectionDeps | null {
  if (!ensureWasm(t)) return null;
  const positions = scanRoomSample();
  registerPointCloudScanCache(HANDLE, positions.length / 3);
  addPointsToScanCache(HANDLE, { positions, normalState: 'absent', pointCount: positions.length / 3 });
  const ifc = fixtureModel('ifc', { idOffset: 0 });
  (ifc.ifcDataStore as { schemaVersion?: string }).schemaVersion = 'IFC4';
  const scan = { ...fixtureModel('scan', { idOffset: 100_000 }), name: 'Apartment.e57', ifcDataStore: undefined, pointCloudHandleId: HANDLE } as unknown as FederatedModel;
  useViewerStore.setState({ models: new Map([['ifc', ifc], ['scan', scan]]), activeModelId: 'ifc' });
  const detector = createScanDetector({ inProcess: true });
  return { detector: () => detector, cloudMatrix: () => null };
}

function buttonNamed(root: HTMLElement, name: string | RegExp): HTMLButtonElement {
  const match = [...root.querySelectorAll('button')].find((b) => {
    const label = b.getAttribute('aria-label') ?? b.textContent ?? '';
    return typeof name === 'string' ? label === name : name.test(label);
  });
  if (!match) throw new Error(`no button ${name}`);
  return match;
}

const rows = (root: HTMLElement) => [...root.querySelectorAll('li')];
const decisions = () => useViewerStore.getState().scanProposalDecisions;

afterEach(() => {
  cleanup();
  clearAllPointCloudScanCaches();
  useViewerStore.setState(initial, true);
});

describe('ScanDetectionSection (#6894)', () => {
  it('Detect elements fills the review list with the proposals for the IFC model', async (t) => {
    const deps = seed(t);
    if (!deps) return;
    const ui = render(<ScanDetectionSection deps={deps} />);
    assert.match(ui.textContent ?? '', /Proposals for ifc \(IFC4\)/);
    click(buttonNamed(ui, 'Detect elements'));
    await waitFor(() => useViewerStore.getState().scanDetectionStatus === 'done', 'detection finished');
    await waitFor(() => rows(ui).length > 0, 'rows rendered');
    const run = useViewerStore.getState().scanDetectionRun!;
    assert.equal(run.sourceModelId, 'scan');
    assert.equal(run.targetModelId, 'ifc');
    assert.equal(rows(ui).length, 7, 'four walls, two slabs, one column');
    assert.match(ui.textContent ?? '', /7 proposals from/);
    assert.ok(buttonNamed(ui, 'Detect again'));
  });

  it('accepting and rejecting one proposal records it and changes what the overlay draws', async (t) => {
    const deps = seed(t);
    if (!deps) return;
    const ui = render(<ScanDetectionSection deps={deps} />);
    click(buttonNamed(ui, 'Detect elements'));
    await waitFor(() => rows(ui).length > 0, 'rows rendered');
    const column = useViewerStore.getState().scanDetectionRun!.result.proposals.proposals.find((p) => p.ifcClass === 'IfcColumn')!;
    click(buttonNamed(ui, `Accept ${column.id}`));
    assert.equal(decisions()[column.id], 'accepted');
    assert.equal(buttonNamed(ui, `Accept ${column.id}`).getAttribute('aria-pressed'), 'true');
    const overlay = () => {
      const s = useViewerStore.getState();
      return detectionOverlayMeshes(s.scanDetectionRun, s.scanProposalDecisions, s.scanProposalFilter, (i) => i);
    };
    assert.ok(overlay().some((m) => m.color[3] === 0.7), 'the accepted column is drawn opaque');
    const firstWall = useViewerStore.getState().scanDetectionRun!.result.proposals.proposals.find((p) => p.ifcClass === 'IfcWall')!;
    const before = overlay().reduce((n, m) => n + m.indices.length, 0);
    click(buttonNamed(ui, `Reject ${firstWall.id}`));
    assert.equal(decisions()[firstWall.id], 'rejected');
    assert.ok(overlay().reduce((n, m) => n + m.indices.length, 0) < before, 'a rejected wall is not drawn');
    // Pressing again clears the decision.
    click(buttonNamed(ui, `Reject ${firstWall.id}`));
    assert.equal(decisions()[firstWall.id], undefined);
    assert.match(ui.textContent ?? '', /1 accepted, 0 rejected, 6 to review/);
  });

  it('the class and confidence filters narrow the list, and Accept all shown accepts only what is shown', async (t) => {
    const deps = seed(t);
    if (!deps) return;
    const ui = render(<ScanDetectionSection deps={deps} />);
    click(buttonNamed(ui, 'Detect elements'));
    await waitFor(() => rows(ui).length > 0, 'rows rendered');
    const wallsBox = [...ui.querySelectorAll('label')].find((l) => /^Walls \(4\)/.test(l.textContent ?? ''))!.querySelector('input')!;
    click(wallsBox);
    assert.equal(rows(ui).length, 3, 'walls hidden');
    click(buttonNamed(ui, 'Accept all shown'));
    const proposals = useViewerStore.getState().scanDetectionRun!.result.proposals.proposals;
    for (const p of proposals) {
      assert.equal(decisions()[p.id], p.ifcClass === 'IfcWall' ? undefined : 'accepted', p.id);
    }
    // A confidence floor above every proposal empties the list.
    const slider = ui.querySelector('input[type="range"]') as HTMLInputElement;
    type(slider, '100');
    assert.equal(useViewerStore.getState().scanProposalFilter.minConfidence, 1);
    assert.equal(rows(ui).length, 0);
    assert.match(ui.textContent ?? '', /No proposals match the filter/);
  });

  it('says it will crop only when the section box is on screen', (t) => {
    const deps = seed(t);
    if (!deps) return;
    const s = useViewerStore.getState();
    const box = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
    // A box hidden by the visibility toggle: detection reads the whole sample, and says so.
    useViewerStore.setState({ sectionPlane: { ...s.sectionPlane, enabled: true, box }, sceneState: { ...s.sceneState, section: { ...s.sceneState.section, visible: false } } });
    const ui = render(<ScanDetectionSection deps={deps} />);
    assert.match(ui.textContent ?? '', /The whole retained scan sample is used/);
    assert.doesNotMatch(ui.textContent ?? '', /Only points inside the section box are used/);
    cleanup();
    const v = useViewerStore.getState();
    useViewerStore.setState({ sceneState: { ...v.sceneState, section: { ...v.sceneState.section, visible: true } } });
    assert.match(render(<ScanDetectionSection deps={deps} />).textContent ?? '', /Only points inside the section box are used/);
  });

  it('without an IFC model the section says so; without a scan there is no section', (t) => {
    const deps = seed(t);
    if (!deps) return;
    useViewerStore.setState({ models: new Map([['scan', useViewerStore.getState().models.get('scan')!]]), activeModelId: 'scan' });
    const ui = render(<ScanDetectionSection deps={deps} />);
    assert.match(ui.textContent ?? '', /No IFC model loaded/);
    cleanup();
    useViewerStore.setState({ models: new Map() });
    assert.equal(render(<ScanDetectionSection deps={deps} />).textContent, '');
  });
});
