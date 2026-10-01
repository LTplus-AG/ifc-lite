/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { DEFAULT_PROFILE, DEFAULT_MAPPING, parseResults, toRdf, type ProfileDefinition } from '@ifc-lite/semantic';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { render, click, cleanup, advance, type } from '@/test/render';
import { SemanticPanel } from '@/components/viewer/SemanticPanel';
import { useSemanticSession } from './session';
import { resolveWithStrategy } from './resolver-context';
import { liveEntities } from './viewer';
import { pilotModel, pilotDocument } from './demo';
import type { ValidationExecutor } from './useSemanticPilot';
import { executeValidation, type ValidationOutput, type ValidationJob } from './validation-job';
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

test('charter #6643 restored invalid pilot stays visibly unvalidated until the real validation pipeline completes', async () => {
  await seed();
  const validated = await executeValidation({ document: pilotDocument() });
  assert.equal(validated.findings.length, 4);
  useSemanticSession.setState({ document: validated.document, graph: validated.graph, findings: validated.findings, report: validated.report, profile: DEFAULT_PROFILE });
  const saved = useSemanticSession.getState().save();
  useSemanticSession.getState().restore(saved);
  let pending: Promise<ValidationOutput> | undefined;
  const ui = render(<SemanticPanel validationExecutor={(job) => { pending = executeValidation(job); return pending; }} />);
  assert.ok(ui.textContent?.includes('Validation has not completed for the current data.'));
  assert.ok(!ui.textContent?.includes('Supplied data conforms within this validation scope.'));
  click(button(ui, 'Validate JSON and graph')); assert.ok(pending);
  await act(async () => { await pending; await Promise.resolve(); });
  assert.equal(useSemanticSession.getState().findings.length, 4);
  assert.ok(!ui.textContent?.includes('Validation has not completed for the current data.'));
  assert.ok(!ui.textContent?.includes('Supplied data conforms within this validation scope.'));
});
test('charter #6643 validate supplied named graph preserves N-Quads format through the real worker job', async () => {
  await seed();
  const graph = (await toRdf(pilotDocument())).split('\n').map(line => line ? line.replace(/ \.$/, ' <urn:pilot:graph> .') : line).join('\n');
  useSemanticSession.setState({ document: undefined, graph, graphFormat: 'application/n-quads', findings: [], profile: DEFAULT_PROFILE });
  let pending: Promise<ValidationOutput> | undefined; let supplied: ValidationJob | undefined;
  const ui = render(<SemanticPanel validationExecutor={job => { supplied = job; pending = executeValidation(job); return pending; }} />);
  click(button(ui, 'Validate supplied RDF graph')); assert.ok(pending);
  await act(async () => { await pending; await Promise.resolve(); });
  assert.equal(supplied?.graphFormat, 'application/n-quads');
  assert.ok(useSemanticSession.getState().graph.includes('<urn:pilot:graph>'));
  assert.equal(ui.querySelector('[role="alert"]'), null);
});
test('charter #6643 editing a graph aborts pending validation and refuses late findings for the prior graph', async () => {
  await seed(); const graph = '<urn:a> <urn:p> "old" .';
  useSemanticSession.setState({ document: undefined, graph, findings: [], profile: DEFAULT_PROFILE });
  const deferred = deferredValidation(); const ui = render(<SemanticPanel validationExecutor={deferred.execute} />);
  click(button(ui, 'Validate supplied RDF graph')); assert.ok(deferred.signal());
  const editor = [...ui.querySelectorAll('textarea')].find(textarea => textarea.value === graph); assert.ok(editor);
  type(editor, '<urn:b> <urn:p> "new" .');
  assert.equal(deferred.signal()?.aborted, true);
  await act(async () => { deferred.finish({ graph, findings: [{ engine: 'SHACL', resourceId: 'urn:a', path: 'urn:p', message: 'Old graph failure' }] }); await Promise.resolve(); });
  assert.ok(!ui.textContent?.includes('Old graph failure'));
  assert.ok(ui.textContent?.includes('Validation has not completed for the current data.'));
  assert.equal(useSemanticSession.getState().graph, '<urn:b> <urn:p> "new" .');
});
test('charter #6643 graph input generation refuses late findings after edits return to the original text', async () => {
  await seed(); const graph = '<urn:a> <urn:p> "old" .';
  useSemanticSession.setState({ document: undefined, graph, findings: [], profile: DEFAULT_PROFILE });
  const deferred = deferredValidation(); const ui = render(<SemanticPanel validationExecutor={deferred.execute} />);
  click(button(ui, 'Validate supplied RDF graph'));
  act(() => { useSemanticSession.getState().setGraph('<urn:b> <urn:p> "new" .'); useSemanticSession.getState().setGraph(graph); });
  await act(async () => { deferred.finish({ graph, findings: [{ engine: 'SHACL', resourceId: 'urn:a', path: 'urn:p', message: 'Old generation failure' }] }); await Promise.resolve(); });
  assert.ok(!ui.textContent?.includes('Old generation failure'));
  assert.ok(ui.textContent?.includes('Validation has not completed for the current data.'));
});

test('charter #6643 restored related subject mapping selects the linked IFC entity without changing the query editor mapping', async () => {
  const authored = await seed(); const revision = 'urn:pilot:revision'; const id = 'urn:pilot:resource';
  const results = parseResults({ head: { vars: ['subject', 'predicate', 'object'] }, results: { bindings: [{ subject: { type: 'uri', value: id }, predicate: { type: 'uri', value: 'urn:pilot:p' }, object: { type: 'literal', value: 'data' } }] } });
  useSemanticSession.setState({ document: undefined, graph: '', results, strategy: 'resource-links', profile: DEFAULT_PROFILE,
    links: [{ resourceId: id, modelRevision: revision, GlobalId: authored.GlobalIds[0] }],
    queries: [{ id: 'current', endpoint: 'https://example.org/sparql', kind: 'select', mapping: { ...DEFAULT_MAPPING, id: 'subject' } }], revisions: new Map([[revision, 'original']]) });
  const saved = useSemanticSession.getState().save(); useSemanticSession.getState().restore(saved);
  useSemanticSession.getState().setRevisions(new Map([[revision, 'original']]));
  const ui = render(<SemanticPanel />);
  const select = ui.querySelector('button[aria-label="Select mapped row"]'); assert.ok(select);
  assert.equal(select.textContent, 'Resolved'); click(select);
  assert.equal(useViewerStore.getState().selectedEntity?.modelId, 'original');
  assert.equal(useViewerStore.getState().selectedEntity?.expressId, authored.doors[0]);
});
test('charter #6643 bundle export labels edited Turtle honestly and omits the N-Quads alias', async () => {
  await seed(); const graph = '@prefix ex: <urn:pilot:> . ex:s ex:p "edited" .';
  useSemanticSession.setState({ document: pilotDocument(), graph, graphFormat: 'text/turtle', profile: DEFAULT_PROFILE, results: undefined });
  const originalCreate = URL.createObjectURL; const originalClick = HTMLAnchorElement.prototype.click;
  let filename = ''; let provide: ((blob: Blob) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const offered = new Promise<Blob>((resolve, reject) => { provide = blob => { clearTimeout(timer); resolve(blob); }; timer = setTimeout(() => reject(new Error('Semantic export did not offer a download')), 5000); });
  URL.createObjectURL = ((blob: Blob) => { assert.ok(provide); provide(blob); return 'blob:semantic-test'; }) as typeof URL.createObjectURL;
  HTMLAnchorElement.prototype.click = function () { filename = this.download; };
  try {
    const ui = render(<SemanticPanel />); click(button(ui, 'Download profile, records and graph'));
    await act(async () => { await offered; await Promise.resolve(); });
    const blob = await offered;
    const bundle: unknown = JSON.parse(await blob.text());
    assert.ok(bundle && typeof bundle === 'object' && 'graph' in bundle && 'graphFormat' in bundle);
    assert.equal(bundle.graph, graph); assert.equal(bundle.graphFormat, 'text/turtle'); assert.ok(!('nquads' in bundle));
    assert.equal(filename, 'semantic-records.json');
  } finally { clearTimeout(timer); URL.createObjectURL = originalCreate; HTMLAnchorElement.prototype.click = originalClick; }
});

test('charter #6643 supplied-graph validation displays the actual SHACL-only partial scope while profile records remain loaded', async () => {
  await seed(); const validated = await executeValidation({ document: pilotDocument() });
  assert.ok(validated.report); assert.equal(validated.report.scope, 'profile'); assert.equal(validated.report.completeness, 'complete');
  useSemanticSession.setState({ document: validated.document, graph: validated.graph, graphFormat: 'application/n-quads', findings: validated.findings, report: validated.report, profile: DEFAULT_PROFILE });
  let pending: Promise<ValidationOutput> | undefined;
  const ui = render(<SemanticPanel validationExecutor={job => { pending = executeValidation(job); return pending; }} />);
  const summary = () => { const element = ui.querySelector('div[aria-label="Validation findings"]'); assert.ok(element); return element; };
  assert.ok(summary().textContent?.includes('Profile records and graph'));
  assert.ok(summary().textContent?.includes('Complete submission')); assert.ok(summary().textContent?.includes('JSON Schema / links / SHACL'));
  click(button(ui, 'Validate supplied RDF graph')); assert.ok(pending);
  await act(async () => { await pending; await Promise.resolve(); });
  assert.ok(useSemanticSession.getState().document);
  assert.ok(summary().textContent?.includes('Supplied RDF graph only'));
  assert.ok(summary().textContent?.includes('Partial view'));
  assert.ok(!summary().textContent?.includes('Complete submission'));
  assert.ok(!summary().textContent?.includes('JSON Schema')); assert.ok(summary().textContent?.includes('SHACL'));
  assert.equal(useSemanticSession.getState().report?.scope, 'graph');
});
