/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, click, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { useViewerStore } from '@/store';
import { captureEvidence, evidenceIsCurrent } from './evidence';
import { replaceEvidence, useAssistant, cancelAssistant } from './conversation';
import { decodeConversation } from './persistence';
import { prepareReportDraft } from './report-draft';
import { validateDocumentSpec } from '../document/types';
import type { GeometryDiagnostics } from '@ifc-lite/geometry';
import type { FederatedModel } from '@/store';

function model(id: string, fields: Partial<FederatedModel>): FederatedModel { return { ...fixtureModel(id), ...fields }; }

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); cancelAssistant(); useViewerStore.setState(initial, true); });
const diagnostics: GeometryDiagnostics = { schemaVersion: 3, totalCsgFailures: 3, productsWithFailures: 2,
  hostsWithOpenings: 2, classification: { rectangular: 2, diagonal: 0, nonRectangular: 0, total: 2 },
  failuresByReason: [{ reason: 'native cut failure', count: 3 }], silentNoOps: 0,
  rectFast: { fired: 0, openingsCut: 0, deferHostNotBox: 0, deferNotThrough: 0, deferOffFace: 0, deferNearEdge: 0, deferNoOpenings: 0 },
  worstHosts: [{ productId: 42, ifcType: 'IfcWall', openings: 2, csgFailures: 3 }],
};

// #6833: unavailable native diagnostics can never be promoted to clean by an evidence adapter.
test('federated load evidence preserves native counters, unavailable paths and exact source scope', () => {
  useViewerStore.setState(fixtureModels(model('native', { diagnostics, loadPath: 'wasm', skipSmallCuts: true }),
    model('cached', { diagnostics: null, loadPath: 'cache', idOffset: 1_000_000 })));
  const snapshot = captureEvidence('loadReport');
  const payload = JSON.parse(snapshot.payload);
  assert.equal(snapshot.totalRows, 2);
  assert.equal(snapshot.includedRows, 2);
  assert.equal(payload.evidence.summary.diagnosticsAvailable, 1);
  assert.equal(payload.evidence.summary.diagnosticsUnavailable, 1);
  assert.equal(payload.evidence.summary.cleanLoads, 0);
  const [native, cached] = payload.evidence.rows.map((row: { data: unknown }) => row.data);
  assert.equal(native.diagnostics.totalCsgFailures, 3);
  assert.equal(native.affectedEntities[0].productId, 42);
  assert.equal(native.affectedEntities[0].renderable, false, 'native identity without bbox is not a fabricated scene target');
  assert.ok(native.actions.some((action: string) => action.includes('small cuts skipped')));
  assert.equal(cached.diagnosticsAvailable, false);
  assert.equal(cached.isClean, false);
  assert.equal(cached.diagnostics, null);
  assert.equal(evidenceIsCurrent(snapshot), true);
  useViewerStore.setState(fixtureModels(model('replacement', { diagnostics: null })));
  assert.equal(evidenceIsCurrent(snapshot), false);
  assert.equal(JSON.parse(snapshot.payload).evidence.rows[0].data.diagnostics.totalCsgFailures, 3);
});

test('large load populations advertise exact native model-report counts and bounded samples', () => {
  useViewerStore.setState(fixtureModels(...Array.from({ length: 120 }, (_, i) => model(`m${i}`, { diagnostics: null }))));
  const snapshot = captureEvidence('loadReport');
  const payload = JSON.parse(snapshot.payload);
  assert.equal(snapshot.totalRows, 120);
  assert.ok(snapshot.includedRows <= 100);
  assert.equal(payload.includedRows, payload.evidence.rows.length);
  assert.equal(payload.evidence.summary.diagnosticsUnavailable, 120);
  assert.equal(payload.sampled, true);
  assert.ok(snapshot.payload.length <= 48_000);
});

test('native load panel action produces portable conversation and native report evidence', () => {
  useViewerStore.setState(fixtureModels(model('cache-model', { diagnostics: null, loadPath: 'cache' })));
  const ui = render(renderPanelBody('loadReport', () => undefined));
  const region = ui.querySelector('section[aria-label="Load report"]');
  assert.ok(region);
  const button = region.querySelector('button[aria-label="Discuss with AI"]');
  assert.ok(button);
  click(button);
  assert.equal(useViewerStore.getState().sidebarActivePanel, 'assistant');
  const snapshot = useAssistant.getState().snapshot;
  assert.equal(snapshot?.source, 'loadReport');
  assert.ok(snapshot);
  replaceEvidence(snapshot);
  useAssistant.setState({ messages: [{ role: 'user', content: 'Explain missing diagnostics' },
    { role: 'assistant', model: 'test-provider', content: 'Diagnostics were unavailable for this cache load [E1].' }] });
  const draft = prepareReportDraft('Load diagnostics');
  assert.deepEqual(validateDocumentSpec(draft.document), []);
  assert.ok(draft.document.blocks.some(block => block.kind === 'text' && block.text.includes('"diagnosticsAvailable": false')));
  assert.ok(decodeConversation(draft.source));
  assert.deepEqual(draft.citations, ['E1']);
});
