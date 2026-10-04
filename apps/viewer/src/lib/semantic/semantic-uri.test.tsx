/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { DEFAULT_PROFILE, parseResults } from '@ifc-lite/semantic';
import { Store as Oxigraph } from 'oxigraph';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { render, click, cleanup, type } from '@/test/render';
import { createSelectionAdapter } from '@/sdk/adapters/selection-adapter';
import { SemanticPanel } from '@/components/viewer/SemanticPanel';
import { SemanticResults } from '@/components/viewer/SemanticResults';
import { useSemanticSession } from './session';
import { liveEntities } from './viewer';
import { queryForSelection } from './related-query';
const initialViewer = useViewerStore.getState(); const initialSession = useSemanticSession.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initialViewer, true); useSemanticSession.setState(initialSession, true); localStorage.clear(); });
const fixture = new URL('../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
const GlobalId = '1Oms875aH3Wg$9l65H2ZGw'; const id = `https://lbd.org/${GlobalId}`;
async function seed(count: number) {
  const bytes = new Uint8Array(await readFile(fixture));
  const data = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  assert.equal(data.entities.getGlobalId(17468), GlobalId, 'actual ArchiCAD door identifies this URI');
  const models = Array.from({ length: count }, (_, index) => ({ ...fixtureModel(`archicad-${index}`, { idOffset: index * 1000000 }), ifcDataStore: data, maxExpressId: Math.max(...data.entities.expressId) }));
  useViewerStore.setState({ ...fixtureModels(...models), ifcDataStore: data, mutationViews: new Map(), selectedEntityId: null, selectedEntityIds: new Set(), selectedEntity: null });
}
function change(select: HTMLSelectElement, value: string) { act(() => { select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true })); }); }
function rowButton(ui: HTMLElement): HTMLButtonElement { const button = ui.querySelector<HTMLButtonElement>('button[aria-label="Select mapped row"]'); assert.ok(button); return button; }
const results = (uri: string) => ({ columns: ['resource'], rows: [{ resource: { type: 'uri' as const, value: uri } }] });

test('URI identity #6783 mounted controls enable real ArchiCAD door selection in renderer and property channels', async context => {
  if (!existsSync(fixture)) { context.skip('Run pnpm fixtures for the real ArchiCAD fixture'); return; }
  await seed(1);
  useSemanticSession.setState({ strategy: 'ifc-global-id', profile: DEFAULT_PROFILE, document: undefined, results: results(id), resultMapping: { id: 'resource' }, graph: '', links: [], revisions: new Map() });
  const ui = render(<SemanticPanel />); assert.equal(rowButton(ui).disabled, true);
  const strategy = ui.querySelector<HTMLSelectElement>('select[aria-label="IFC identity strategy"]'); assert.ok(strategy); change(strategy, 'resource-uri');
  assert.equal(rowButton(ui).textContent, 'Resolved'); click(rowButton(ui));
  assert.deepEqual(createSelectionAdapter(useViewerStore).get(), [{ modelId: 'archicad-0', expressId: 17468 }]);
  assert.equal(useViewerStore.getState().selectedEntityId, 17468); assert.equal(useViewerStore.getState().selectedEntity?.expressId, 17468);
  assert.equal(useViewerStore.getState().selectedEntityIds.has(17468), true);
  const template = [...ui.querySelectorAll('input')].find(input => input.value === 'https://lbd.org/{GlobalId}'); assert.ok(template);
  type(template, 'https://other.org/{GlobalId}'); const apply = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Apply URI template'); assert.ok(apply); click(apply);
  assert.equal(rowButton(ui).disabled, true, 'template changes re-evaluate identity diagnostics');
});

test('URI identity #6783 real engine encoded subject rows remain ambiguous until an explicit current model choice', async context => {
  if (!existsSync(fixture)) { context.skip('Run pnpm fixtures for the real ArchiCAD fixture'); return; }
  await seed(2); const encoded = id.replace('$', '%24');
  useSemanticSession.setState({ strategy: 'resource-uri', uriConfig: { mode: 'template', template: 'https://lbd.org/{GlobalId}' }, links: [], revisions: new Map() });
  const engine = new Oxigraph(); engine.load(`<${encoded}> <urn:label> "ArchiCAD door" .`, { format: 'text/turtle' });
  const response = engine.query('SELECT ?resource WHERE { ?resource <urn:label> ?label }', { results_format: 'application/sparql-results+json' }); assert.equal(typeof response, 'string');
  const raw = parseResults(JSON.parse(response as string) as unknown);
  const ui = render(<SemanticResults results={raw} mapping={{ id: 'resource' }} revisions={new Map()} onError={error => { throw error; }} />);
  assert.equal(rowButton(ui).textContent, 'Ambiguous'); click(rowButton(ui));
  const choose = [...ui.querySelectorAll('fieldset button')].find(button => button.textContent?.includes('archicad-1')); assert.ok(choose); click(choose);
  assert.deepEqual(createSelectionAdapter(useViewerStore).get(), [{ modelId: 'archicad-1', expressId: 17468 }]);
  assert.equal(useViewerStore.getState().selectedEntityId, 1017468); assert.equal(useViewerStore.getState().selectedEntity?.modelId, 'archicad-1');
  const query = queryForSelection({ selection: createSelectionAdapter(useViewerStore).get(), entities: liveEntities(), revisions: new Map(), settings: useSemanticSession.getState(), profile: DEFAULT_PROFILE, mapping: { id: 'resource' }, results: raw });
  // Reverse lookup uses the explicitly selected IFC candidate without rewriting a known RDF URI.
  assert.ok(query.includes(`<${encoded}>`)); assert.ok(!query.includes(`<${id}>`));
  assert.equal(raw.rows[0].resource.value, encoded, 'the original RDF identity is not normalized');
});

test('URI identity #6783 portable configuration is validated and restoration clears model associations', () => {
  useSemanticSession.getState().setUriConfig({ mode: 'template', template: 'https://example.org/items/{GlobalId}/resource' });
  useSemanticSession.setState({ strategy: 'resource-uri', document: undefined, results: undefined, graph: '', revisions: new Map([['revision', 'obsolete-session']]), queries: [] });
  const serialized = useSemanticSession.getState().save(); assert.ok(!serialized.includes('obsolete-session'));
  useSemanticSession.getState().restore(serialized);
  assert.equal(useSemanticSession.getState().strategy, 'resource-uri'); assert.deepEqual(useSemanticSession.getState().uriConfig, { mode: 'template', template: 'https://example.org/items/{GlobalId}/resource' });
  assert.equal(useSemanticSession.getState().revisions.size, 0); assert.deepEqual(useSemanticSession.getState().pendingRevisions, [{ revision: 'revision', modelLabel: '' }]);
  const tampered: Record<string, unknown> = JSON.parse(serialized) as Record<string, unknown>; tampered.uriConfig = { mode: 'template', template: 'https://example.org/{GlobalId}?token=SECRET' };
  assert.throws(() => useSemanticSession.getState().restore(JSON.stringify(tampered)), /query|fragment/);
  useSemanticSession.getState().setUriConfig({ mode: 'last-path-segment' }); const last = useSemanticSession.getState().save(); useSemanticSession.getState().restore(last);
  assert.deepEqual(useSemanticSession.getState().uriConfig, { mode: 'last-path-segment' });
});
