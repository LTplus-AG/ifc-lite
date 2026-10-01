/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { DEFAULT_PROFILE, parseResults, type ProfileDefinition } from '@ifc-lite/semantic';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { render, click, cleanup, advance } from '@/test/render';
import { SemanticPanel } from '@/components/viewer/SemanticPanel';
import { useSemanticSession } from './session';
import { resolveWithStrategy } from './resolver-context';
import { liveEntities } from './viewer';
import { pilotModel, pilotDocument } from './demo';
import type { ValidationExecutor } from './useSemanticPilot';
import type { ValidationOutput } from './validation-job';
const original = useViewerStore.getState(); const originalSession = useSemanticSession.getState();
afterEach(() => { cleanup(); useViewerStore.setState(original, true); useSemanticSession.setState(originalSession, true); localStorage.clear(); });
async function seed(modelId = 'original') {
  const authored = pilotModel(0);
  const data = await new IfcParser().parseColumnar(new TextEncoder().encode(authored.content).buffer, { disableWorkerScan: true });
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel(modelId), ifcDataStore: data, maxExpressId: Math.max(...data.entities.expressId) }), ifcDataStore: data, mutationViews: new Map() });
  return authored;
}
function deferredValidation() {
  let complete: ((value: ValidationOutput) => void) | undefined; let signal: AbortSignal | undefined;
  const execute: ValidationExecutor = (_job, supplied) => { signal = supplied; return new Promise(resolve => { complete = resolve; }); };
  return { execute, signal: () => signal, finish: (value: ValidationOutput) => { assert.ok(complete); complete(value); } };
}
function button(ui: HTMLElement, text: string): HTMLElement {
  const element = [...ui.querySelectorAll('button')].find(candidate => candidate.textContent === text); assert.ok(element, text); return element;
}
test('charter #6643 workspace preserves RDF terms, custom profile and graph while revoking grants/session associations', async () => {
  const authored = await seed(); const revision = 'https://example.org/revision';
  const profile: ProfileDefinition = { ...DEFAULT_PROFILE, id: 'https://example.org/custom-profile', version: '2.0.0' };
  const results = parseResults({ head: { vars: ['label', 'value', 'optional'] }, results: { bindings: [{ label: { type: 'literal', value: 'Tür', 'xml:lang': 'de' }, value: { type: 'literal', value: '01', datatype: 'http://www.w3.org/2001/XMLSchema#integer' } }] } });
  const graph = '<https://example.org/inspection> <https://example.org/about> <https://example.org/product> .\n';
  const query = { id: 'custom', endpoint: 'https://example.org/sparql', kind: 'select' as const, query: 'SELECT * WHERE {?s ?p ?o}', bearer: 'SECRET', grantedHost: 'example.org' };
  const link = { resourceId: 'https://example.org/product', modelRevision: revision, GlobalId: authored.GlobalIds[0], modelId: 'original', expressId: 999 };
  useSemanticSession.setState({ profile, document: undefined, results, graph, strategy: 'resource-links', links: [link], revisions: new Map([[revision, 'original']]), queries: [query], retrievedAt: '2026-10-01T00:00:00Z' });
  const saved = useSemanticSession.getState().save();
  assert.ok(!saved.includes('SECRET')); assert.ok(!saved.includes('grantedHost')); assert.ok(!saved.includes('expressId')); assert.ok(!saved.includes('"original"'));
  useSemanticSession.getState().restore(saved); const restored = useSemanticSession.getState();
  assert.deepEqual(restored.results, results); assert.equal(restored.graph, graph); assert.equal(restored.profile.id, profile.id);
  assert.equal(restored.revisions.size, 0); assert.deepEqual(restored.pendingRevisions, [{ revision, modelLabel: '' }]); assert.equal(restored.retrievedAt, undefined);
  assert.equal(resolveWithStrategy({ id: link.resourceId }, { entities: liveEntities(), revisions: restored.revisions }, restored).status, 'unscoped');
  await seed('reloaded'); useSemanticSession.getState().setRevisions(new Map([[revision, 'reloaded']]));
  const current = useSemanticSession.getState();
  const resolution = resolveWithStrategy({ id: link.resourceId }, { entities: liveEntities(), revisions: current.revisions }, current);
  assert.equal(resolution.status, 'resolved'); if (resolution.status === 'resolved') assert.equal(resolution.ref.modelId, 'reloaded');
});
test('charter #6643 profile change cancels pending panel validation and late output cannot replace records', async () => {
  await seed(); useSemanticSession.setState({ document: undefined, graph: '', findings: [], results: undefined, profile: DEFAULT_PROFILE });
  const deferred = deferredValidation(); const ui = render(<SemanticPanel validationExecutor={deferred.execute} />);
  click(button(ui, 'Load records')); assert.ok(deferred.signal());
  act(() => useSemanticSession.getState().setProfile({ ...DEFAULT_PROFILE, id: 'https://example.org/new-profile', version: '2.0.0' }));
  await advance(0); assert.equal(deferred.signal()?.aborted, true);
  await act(async () => { deferred.finish({ document: pilotDocument(), graph: 'stale graph', findings: [] }); await Promise.resolve(); });
  assert.equal(useSemanticSession.getState().document, undefined); assert.equal(useSemanticSession.getState().graph, '');
});
test('charter #6643 model replacement rejects late panel import against prior model scope', async () => {
  await seed(); useSemanticSession.setState({ document: undefined, graph: '', findings: [], results: undefined, profile: DEFAULT_PROFILE });
  const deferred = deferredValidation(); const ui = render(<SemanticPanel validationExecutor={deferred.execute} />);
  click(button(ui, 'Load records')); assert.ok(deferred.signal());
  await act(async () => { await seed('replacement'); });
  await act(async () => { deferred.finish({ document: pilotDocument(), graph: 'stale graph', findings: [] }); await Promise.resolve(); });
  assert.equal(useSemanticSession.getState().document, undefined); assert.equal(useSemanticSession.getState().graph, '');
  assert.ok(ui.querySelector('[role="alert"]')?.textContent?.includes('Loaded models changed'));
});
