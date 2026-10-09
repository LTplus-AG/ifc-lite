/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { captureEvidence } from '@/lib/assistant/evidence';
import { loadReportAdapter } from '@/lib/assistant/adapters/load-report';
import { EvidenceView } from '@/components/viewer/analysis/EvidenceView';
import { render, cleanup } from '@/test/render';
import { parseNewIfcProposal, prepareNewIfcFile } from './new-ifc-file';
const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });
const proposal = (Name: string) => parseNewIfcProposal(JSON.stringify({ version: 1, kind: 'ifc.create', title: Name, filename: `${Name}.ifc`, project: { Name, Schema: 'IFC4', LengthUnit: 'METRE' }, storeys: [{ Name: 'Ground', Elevation: 0 }] }));

test('#7326 native scaffold capability does not present an absent load report as an empty captured result', () => {
  useViewerStore.setState({ models: new Map(), ifcDataStore: null });
  assert.equal(loadReportAdapter.readiness(useViewerStore.getState()).ready, true, 'new-file discussion remains usable');
  const evidence = captureEvidence('loadReport');
  const payload = JSON.parse(evidence.payload);
  assert.equal(payload.evidence.summary.loadReportsAvailable, false);
  assert.equal(payload.evidence.summary.nativeNewIfc.existingModelFacts, false);
  assert.equal(payload.sourceAvailability, 'unavailable');
  const ui = render(<EvidenceView evidence={evidence} state="captured" />);
  assert.match(ui.textContent ?? '', /available at capture/);
  assert.doesNotMatch(ui.textContent ?? '', /captured native result is empty/i);
});

test('#7326 changing the actual legacy parsed IFC revokes a held primary-load request', async () => {
  const parser = new IfcParser();
  const first = await prepareNewIfcFile(proposal('First native project'));
  const replacement = await prepareNewIfcFile(proposal('Replacement native project'));
  const parse = (content: string) => parser.parseColumnar(new TextEncoder().encode(content).buffer, { disableWorkerScan: true });
  const firstStore = await parse(first.content), replacementStore = await parse(replacement.content);
  useViewerStore.setState({ models: new Map(), ifcDataStore: firstStore, loading: false, dirtyModels: new Set(), collabRoomId: null });
  const held = await prepareNewIfcFile(proposal('Reviewed next project'));
  let requests = 0;
  const listener = () => { requests++; };
  window.addEventListener('ifc-lite:load-file', listener);
  try {
    useViewerStore.setState({ ifcDataStore: replacementStore });
    assert.throws(() => held.requestPrimaryLoad(), /workspace changed/);
    assert.equal(requests, 0, 'superseded native source cannot publish a replacement request');
    useViewerStore.setState({ ifcDataStore: firstStore });
    held.requestPrimaryLoad();
    assert.equal(requests, 1, 'the exact captured native legacy source remains an allowed control');
  } finally { window.removeEventListener('ifc-lite:load-file', listener); }
});
