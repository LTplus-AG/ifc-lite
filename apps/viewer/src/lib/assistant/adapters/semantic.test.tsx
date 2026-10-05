/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE_ID, createValidationReport, validateJson, validateLinks, type SemanticDocument, type SemanticResource } from '@ifc-lite/semantic';
import { cleanup, click, render, waitFor } from '@/test/render';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { useViewerStore } from '@/store';
import { captureEvidence, evidenceIsCurrent } from '../evidence';
import { cancelAssistant, replaceEvidence, useAssistant } from '../conversation';
import { sendAssistant } from '../request';
import { safeIri } from './semantic';
import { architectureSample, idsOfType, sampleModel } from './coordination.test-support';

const initial = useViewerStore.getState();
let resetSemantic: (() => void) | null = null;
afterEach(() => {
  cleanup(); cancelAssistant(); useViewerStore.setState(initial, true); resetSemantic?.();
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

/** The Linked records panel chunk, as the lazy panel loads it; it hands its session to the adapter. */
async function loadPanelChunk() {
  await import('@/components/viewer/SemanticPanel');
  const { useSemanticSession } = await import('@/lib/semantic/session');
  const fresh = useSemanticSession.getState();
  resetSemantic = () => useSemanticSession.setState(fresh, true);
  return useSemanticSession;
}

interface Row { kind: string; status: string; modelId: string | null; expressId: number | null; globalId: string | null;
  recordId: string; type: string; label: string; candidateCount: number | null; engine?: string; path?: string; message?: string }
const rowsOf = (payload: string): Row[] => JSON.parse(payload).evidence.rows.map((row: { data: Row }) => row.data);
const summaryOf = (payload: string) => JSON.parse(payload).evidence.summary;

const BASE = 'https://records.example.org/project/';
const SECRET_SOURCE = 'https://reader:hunter2@sparql.example.org/endpoint?access_token=SECRET-TOKEN';

async function seedModels(ids: string[]) {
  const store = await architectureSample();
  useViewerStore.setState({ models: new Map(ids.map((id, index) => [id, sampleModel(id, store, index * 1_000_000)] as const)),
    activeModelId: ids[0], mutationViews: new Map() });
  return store;
}

function records(doorGlobalId: string, revision?: string): SemanticResource[] {
  return [
    { id: `${BASE}building`, type: 'Building', label: 'Building record' },
    { id: `${BASE}product`, type: 'Product', label: 'Door product', granularity: 'item' },
    { id: `${BASE}door?sig=SIGNED-QUERY`, type: 'Installation', label: 'Installed door', buildingId: `${BASE}building`,
      productId: `${BASE}product`, GlobalId: doorGlobalId, ...(revision ? { modelRevision: revision } : {}) },
    { id: `${BASE}missing`, type: 'Installation', label: 'Door not in the model', buildingId: `${BASE}building`,
      productId: `${BASE}product`, GlobalId: '0000000000000000000999' },
    // No productId: the profile requires it, so validation reports a real finding.
    { id: `${BASE}incomplete`, type: 'Installation', label: 'Incomplete installation', buildingId: `${BASE}building`, GlobalId: doorGlobalId },
  ];
}

test('#6833 semantic: nothing is attachable before the Linked records panel has loaded records', async () => {
  await seedModels(['A']);
  const before = captureEvidence('semantic');
  assert.equal(JSON.parse(before.payload).sourceAvailability, 'unavailable');
  await loadPanelChunk();
  const empty = captureEvidence('semantic');
  assert.equal(JSON.parse(empty.payload).sourceAvailability, 'unavailable', 'an empty session is not a clean result');
});

test('#6833 semantic: records resolve to real sample elements, findings follow, and no source or credential leaks', async () => {
  const store = await seedModels(['A']);
  const session = await loadPanelChunk();
  const door = idsOfType(store, 'IfcDoor')[0] ?? idsOfType(store, 'IfcWall')[0];
  const doorGlobalId = store.entities.getGlobalId(door);
  const document: SemanticDocument = { profile: PROFILE_ID, source: SECRET_SOURCE, completeness: 'partial', resources: records(doorGlobalId) };
  const findings = [...validateJson(document), ...validateLinks(document)];
  assert.ok(findings.length > 0, 'the incomplete installation fails the profile');
  session.getState().setDocument(document);
  session.getState().setFindings(findings);
  session.getState().setReport(createValidationReport({ scope: 'profile', completeness: 'partial', source: SECRET_SOURCE, findings }));

  const snapshot = captureEvidence('semantic');
  const summary = summaryOf(snapshot.payload);
  const rows = rowsOf(snapshot.payload);
  assert.equal(snapshot.totalRows, 5 + findings.length);
  assert.equal(summary.recordCount, 5);
  assert.equal(summary.completeness, 'partial');
  assert.deepEqual(summary.resolution, { external: 2, resolved: 2, unmatched: 1 });
  assert.equal(summary.findingCount, findings.length);
  assert.equal(summary.validation.conforms, false);
  const installed = rows.find(row => row.label === 'Installed door');
  assert.ok(installed);
  assert.equal(installed.status, 'resolved');
  assert.deepEqual([installed.modelId, installed.expressId, installed.globalId], ['A', door, doorGlobalId]);
  assert.equal(installed.recordId, `${BASE}door`, 'query strings are dropped from record IRIs');
  assert.equal(rows.find(row => row.label === 'Door not in the model')?.status, 'unmatched');
  const finding = rows.find(row => row.kind === 'semanticFinding');
  assert.equal(finding?.recordId, `${BASE}incomplete`);
  assert.equal(finding?.status, 'Violation');
  for (const secret of ['SECRET-TOKEN', 'hunter2', 'sparql.example.org', 'SIGNED-QUERY']) {
    assert.ok(!snapshot.payload.includes(secret), `${secret} never reaches the evidence`);
  }
  assert.equal(evidenceIsCurrent(snapshot), true);

  session.getState().setFindings([]);
  assert.equal(evidenceIsCurrent(snapshot), false, 'new validation output is a different native result');
  const revalidated = captureEvidence('semantic');
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(evidenceIsCurrent(revalidated), false, 'an edit can change what records resolve to');
});

test('#6833 semantic: two models are ambiguous until a revision is associated; large documents keep native totals', async () => {
  const store = await seedModels(['A', 'B']);
  const session = await loadPanelChunk();
  const [wall] = idsOfType(store, 'IfcWall');
  const globalId = store.entities.getGlobalId(wall);
  const revision = `${BASE}revision/2`;
  const extra = Array.from({ length: 120 }, (_, i): SemanticResource => ({ id: `${BASE}building-${i}`, type: 'Building', label: `Building ${i}` }));
  session.getState().setDocument({ profile: PROFILE_ID, source: 'urn:ifc-lite:local', completeness: 'complete',
    resources: [...records(globalId, revision), ...extra] });

  const unscoped = captureEvidence('semantic');
  assert.equal(rowsOf(unscoped.payload).find(row => row.label === 'Installed door')?.status, 'unscoped');
  assert.equal(rowsOf(unscoped.payload).find(row => row.label === 'Incomplete installation')?.candidateCount, 2,
    'the same GlobalId in two federated models is ambiguous, never guessed');

  session.getState().setRevisions(new Map([[revision, 'B']]));
  assert.equal(evidenceIsCurrent(unscoped), false, 'associating a revision changes resolution');
  const scoped = captureEvidence('semantic');
  const payload = JSON.parse(scoped.payload);
  const installed = rowsOf(scoped.payload).find(row => row.label === 'Installed door');
  assert.deepEqual([installed?.status, installed?.modelId, installed?.expressId], ['resolved', 'B', wall]);
  assert.equal(scoped.totalRows, 125);
  assert.ok(scoped.includedRows <= 100);
  assert.equal(payload.sampled, true);
  assert.equal(payload.evidence.summary.recordsByType.Building, 121);
});

test('#6833 semantic: the Linked records panel header attaches its records', async () => {
  const store = await seedModels(['A']);
  const session = await loadPanelChunk();
  session.getState().setDocument({ profile: PROFILE_ID, source: 'urn:ifc-lite:local', completeness: 'complete',
    resources: records(store.entities.getGlobalId(idsOfType(store, 'IfcWall')[0])) });
  const ui = render(renderPanelBody('semantic', () => undefined));
  const discuss = () => ui.querySelector<HTMLButtonElement>('button[aria-label="Discuss with AI"]');
  await waitFor(() => discuss() !== null, 'the lazy panel renders its header');
  const button = discuss();
  assert.ok(button);
  click(button);
  assert.equal(useAssistant.getState().snapshot?.source, 'semantic');
  assert.equal(useAssistant.getState().snapshot?.totalRows, 5);
});

test('#6833 semantic: fragments and malformed IRIs never carry tokens into evidence', () => {
  assert.equal(safeIri('https://records.example.org/rec#access_token=FRAGMENT-TOKEN'), 'https://records.example.org/rec');
  for (const raw of ['https://user:pw@[bad/rec?token=MALFORMED-TOKEN', 'urn:x:rec?sig=URN-TOKEN#frag=URN-FRAGMENT', 'reader:pw@host/rec']) {
    const safe = safeIri(raw);
    for (const secret of ['MALFORMED-TOKEN', 'URN-TOKEN', 'URN-FRAGMENT', 'pw@']) assert.ok(!safe.includes(secret), `${raw} -> ${safe}`);
  }
});

test('#6833 semantic: a Linked records change while an answer streams makes that answer stale', async () => {
  const store = await seedModels(['A']);
  const session = await loadPanelChunk();
  const door = idsOfType(store, 'IfcDoor')[0] ?? idsOfType(store, 'IfcWall')[0];
  session.getState().setDocument({ profile: PROFILE_ID, completeness: 'partial', resources: records(store.entities.getGlobalId(door)) });
  replaceEvidence(captureEvidence('semantic'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream());
  try {
    const pending = sendAssistant('Explain', 'openai/gpt-free', '/api/chat');
    await new Promise(resolve => setImmediate(resolve));
    session.getState().setDocument(undefined);
    await pending;
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(useAssistant.getState().error, 'stale-evidence', 'the viewer store never changed, the linked records did');
  assert.equal(useAssistant.getState().messages.length, 0);
});
