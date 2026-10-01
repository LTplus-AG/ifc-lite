import '@/test/setup-dom.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { act } from 'react';
import { Store as Oxigraph } from 'oxigraph';
import { IfcParser } from '@ifc-lite/parser';
import { EntityNode } from '@ifc-lite/query';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { render, click, cleanup, advance, type as input } from '@/test/render';
import { createSelectionAdapter } from '@/sdk/adapters/selection-adapter';
import { createQueryAdapter } from '@/sdk/adapters/query-adapter';
import { createMutateAdapter } from '@/sdk/adapters/mutate-adapter';
import { createExportAdapter } from '@/sdk/adapters/export-adapter';
import { SemanticPanel } from '@/components/viewer/SemanticPanel';
import { DEMO_BASE, DEMO_REVISIONS, PILOT_QUERY, pilotDocument, pilotModel } from './demo';
import { assertSelect, parseResults, request, resourcesFromResults } from './transport';
import { parseDocument, parseImport, toRdf, validateGraph, validateJson, validateLinks } from './validation';
import { relatedResources, resolveResource, selectionTargets } from './resolver';
import { liveEntities, projectFireRating, selectResources } from './viewer';
import { PROFILE_ID, VOCAB } from './types';
import { useSemanticSession } from './session';

const original = useViewerStore.getState();
const session = useSemanticSession.getState();
afterEach(() => { cleanup(); useViewerStore.setState(original, true); useSemanticSession.setState(session, true); });
async function seed(count = 2) {
  const authored = pilotModel(0);
  const data = await new IfcParser().parseColumnar(new TextEncoder().encode(authored.content).buffer, { disableWorkerScan: true });
  const models = Array.from({ length: count }, (_, index) => ({ ...fixtureModel(`m${index}`, { idOffset: index * 1_000_000 }),
    ifcDataStore: data, maxExpressId: Math.max(...data.entities.expressId) }));
  useViewerStore.setState({ ...fixtureModels(...models), ifcDataStore: data,
    selectedEntityId: null, selectedEntityIds: new Set(), selectedEntity: null, selectedEntities: [], mutationViews: new Map() });
  return { authored, revisions: new Map(DEMO_REVISIONS.map((uri, index) => [uri, `m${index}`])) };
}
const sorted = (resources: ReturnType<typeof pilotDocument>['resources']) => [...resources].sort((a, b) => a.id.localeCompare(b.id));
function selectJson(rdf: string) {
  const store = new Oxigraph(); store.load(rdf, { format: 'application/n-quads' });
  const result = store.query(PILOT_QUERY, { results_format: 'application/sparql-results+json' });
  assert.equal(typeof result, 'string');
  return JSON.parse(result as string) as unknown;
}

test('discussion #6635: real SPARQL SELECT and JSON retain the same records and non-IFC relationships', async () => {
  const document = parseDocument(pilotDocument()); const rdf = await toRdf(document);
  const bindings = parseResults(selectJson(rdf));
  const projected = resourcesFromResults(bindings, document.source);
  assert.deepEqual(sorted(projected.resources), sorted(document.resources));
  assert.equal(projected.completeness, 'partial');
  const connected = relatedResources(projected.resources, [DEMO_BASE + 'installation/1']);
  assert.ok(connected.some(record => record.type === 'Inspection' && record.evidenceId?.endsWith('inspection.pdf')));
  assert.ok(connected.some(record => record.id === DEMO_BASE + 'batch-passport'));
  assert.ok(rdf.includes(VOCAB + 'replacesId'));
});
test('JSON and SHACL report the same missing passport fields; closed shapes reject unexpected predicates', async () => {
  const document = pilotDocument();
  const json = validateJson(document); const rdf = await toRdf(document); const shacl = await validateGraph(rdf);
  assert.deepEqual(new Set(json.map(finding => finding.resourceId)), new Set([DEMO_BASE + 'incomplete-passport']));
  assert.deepEqual(new Set(shacl.map(finding => finding.resourceId)), new Set([DEMO_BASE + 'incomplete-passport']));
  assert.equal(json.length, 2); assert.equal(shacl.length, 2);
  const bad = rdf + `<${DEMO_BASE}building> <${VOCAB}unknown> "unexpected" .\n`;
  assert.ok((await validateGraph(bad)).some(finding => finding.resourceId === DEMO_BASE + 'building'));
  await assert.rejects(validateGraph('<https://example.org/x> <https://example.org/p> "untyped" .'), /no targets/i);
  assert.throws(() => parseDocument({ ...document, resources: [{ ...document.resources[0], unknown: 'lost' }] }), /additional properties/);
  assert.throws(() => parseDocument({ ...document, resources: [document.resources[0], document.resources[0]] }), /Duplicate/);
  const missing = { ...document, resources: document.resources.filter(record => record.id !== DEMO_BASE + 'batch') };
  assert.ok(validateLinks(missing).length > 0);
  assert.equal(validateLinks({ ...missing, completeness: 'partial' }).length, 0);
});
test('SELECT transport preserves RDF terms and refuses updates, federation, conflicting rows and wrong hosts', async () => {
  assertSelect(PILOT_QUERY);
  for (const query of ['DELETE WHERE { ?s ?p ?o }', 'ASK { ?s ?p ?o }',
    'SELECT * WHERE { SERVICE <https://example.org> { ?s ?p ?o } }',
    'SELECT * FROM <https://example.org/g> WHERE { ?s ?p ?o }']) assert.throws(() => assertSelect(query));
  const results = parseResults({ head: { vars: ['id', 'type', 'label', 'extra'] }, results: { bindings: [
    { id: { type: 'uri', value: DEMO_BASE + 'building' }, type: { type: 'uri', value: VOCAB + 'Building' },
      label: { type: 'literal', value: 'Gebäude', 'xml:lang': 'de' }, extra: { type: 'bnode', value: 'evidence' } },
  ] } });
  assert.equal(results.rows[0].label['xml:lang'], 'de'); assert.equal(results.rows[0].extra.type, 'bnode');
  assert.equal(resourcesFromResults(results, DEMO_BASE).resources[0].label, 'Gebäude');
  assert.throws(() => resourcesFromResults({ ...results, rows: [...results.rows, { ...results.rows[0], label: { type: 'literal', value: 'Conflict' } }] }, DEMO_BASE), /Conflicting/);
  await assert.rejects(request('https://denied.example/data', 'example.org', new AbortController().signal), /not covered/);
  await assert.rejects(request('http://example.org/data', 'example.org', new AbortController().signal), /https/i);
});
test('real HTTP endpoint runs SPARQL POST and bounded JSON GET through the granted transport', async () => {
  const document = pilotDocument(); const rdf = await toRdf(document); let posts = 0;
  const server = createServer(async (incoming, outgoing) => {
    try {
      outgoing.setHeader('Access-Control-Allow-Origin', '*');
      if (incoming.method === 'POST') {
        let body = ''; for await (const chunk of incoming) body += chunk;
        assert.equal(new URLSearchParams(body).get('query'), PILOT_QUERY); posts++;
        outgoing.setHeader('Content-Type', 'application/sparql-results+json'); outgoing.end(JSON.stringify(selectJson(rdf)));
      } else { outgoing.setHeader('Content-Type', 'application/json'); outgoing.end(JSON.stringify(document)); }
    } catch (failure) { outgoing.statusCode = 500; outgoing.end(String(failure)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  // Only the test transport rewrites to local HTTP; production always uses gated HTTPS.
  const transport = (url: URL, init: RequestInit) => fetch(`http://127.0.0.1:${address.port}${url.pathname}`, init);
  try {
    const signal = new AbortController().signal;
    assert.deepEqual(parseDocument(await request('https://example.org/records', 'example.org', signal, undefined, transport)), document);
    const result = parseResults(await request('https://example.org/query', 'example.org', signal, PILOT_QUERY, transport));
    assert.deepEqual(sorted(resourcesFromResults(result, document.source).resources), sorted(document.resources));
    assert.equal(posts, 1);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(request('https://example.org/query', 'example.org', cancelled.signal, PILOT_QUERY, transport));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
test('single and federated selections use real IFC entities, reject ambiguous GUIDs and stale model addresses', async () => {
  for (const count of [1, 2]) {
    const { authored, revisions } = await seed(count); const installation = pilotDocument().resources.find(record => record.id.endsWith('installation/1'))!;
    assert.equal(liveEntities().filter(entity => entity.GlobalId === authored.GlobalIds[0]).length, count);
    assert.equal(selectResources([installation], revisions), 1);
    assert.deepEqual(createSelectionAdapter(useViewerStore).get(), [{ modelId: 'm0', expressId: authored.doors[0] }]);
    assert.equal(useViewerStore.getState().isEntitySelected({ modelId: 'm0', expressId: authored.doors[0] }), true);
    assert.ok(useViewerStore.getState().selectedEntityIds.has(authored.doors[0]));
    const unscoped = { ...installation, modelRevision: undefined };
    assert.equal(resolveResource(unscoped, liveEntities(), revisions).status, count === 2 ? 'ambiguous' : 'resolved');
    assert.equal(selectResources([unscoped], revisions), count === 2 ? 0 : 1);
    assert.equal(resolveResource(installation, liveEntities(), new Map()).status, 'unscoped');
    createSelectionAdapter(useViewerStore).set([{ modelId: 'm0', expressId: 999999 }]);
    assert.equal(useViewerStore.getState().selectedEntityIds.size, 0);
    if (count === 2) {
      const previous = pilotDocument().resources.find(record => record.id.endsWith('previous'))!;
      selectResources([previous], revisions);
      assert.ok(useViewerStore.getState().selectedEntityIds.has(1_000_000 + authored.doors[0]));
    }
    useViewerStore.setState({ models: new Map(), ifcDataStore: null });
    createSelectionAdapter(useViewerStore).set([{ modelId: 'm0', expressId: authored.doors[0] }]);
    assert.equal(useViewerStore.getState().selectedEntityIds.size, 0);
  }
});
test('FireRating projection writes provenance, reverses in one undo, and follows effective GlobalId edits and deletions', async () => {
  const { authored, revisions } = await seed();
  const document = pilotDocument(); const installation = document.resources.find(record => record.id.endsWith('installation/1'))!;
  const product = document.resources.find(record => record.id === installation.productId)!;
  const ref = { modelId: 'm0', expressId: authored.doors[0] };
  useViewerStore.setState({ editEnabled: true });
  projectFireRating(installation, product, revisions, document.source, PROFILE_ID);
  const query = createQueryAdapter(useViewerStore);
  const properties = () => query.properties(ref);
  assert.ok(JSON.stringify(properties()).includes('EI30'));
  assert.ok(JSON.stringify(properties()).includes(document.source));
  assert.ok(JSON.stringify(properties()).includes(product.id));
  const exported = createExportAdapter(useViewerStore).ifc([ref], { includeMutations: true });
  const bytes = typeof exported === 'string' ? new TextEncoder().encode(exported) : new Uint8Array(exported);
  const reopened = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
  const exportedDoor = reopened.entities.getExpressIdByGlobalId(installation.GlobalId!);
  const exportedProperties = new EntityNode(reopened, exportedDoor).properties();
  assert.ok(exportedProperties.some(pset => pset.name === 'Pset_DoorCommon' && pset.properties.some(property => property.name === 'FireRating' && property.value === 'EI30')));
  assert.ok(exportedProperties.some(pset => pset.name === 'Pset_SemanticProjection' && pset.properties.some(property => property.name === 'ProductId' && property.value === product.id)));
  const mutation = createMutateAdapter(useViewerStore); assert.equal(mutation.undo('m0'), true);
  assert.ok(!JSON.stringify(properties()).includes('EI30'));
  assert.ok(!JSON.stringify(properties()).includes('Pset_SemanticProjection'));
  mutation.setAttribute(ref, 'GlobalId', '0000000000000000000888');
  assert.equal(resolveResource(installation, liveEntities(), revisions).status, 'unmatched');
  assert.equal(resolveResource({ ...installation, GlobalId: '0000000000000000000888' }, liveEntities(), revisions).status, 'resolved');
  const view = useViewerStore.getState().mutationViews.get('m0')!;
  view.deleteEntity(ref.expressId);
  assert.equal(selectResources([{ ...installation, GlobalId: '0000000000000000000888' }], revisions), 0);
});
test('mounted panel loads records, shows validation, selects linked IFC geometry and filters from viewport selection', async () => {
  const { authored } = await seed(1);
  const ui = render(<SemanticPanel />);
  const button = (label: string) => { const found = [...ui.querySelectorAll('button')].find(node => node.textContent === label); assert.ok(found, label); return found; };
  click(button('Use example records'));
  for (let index = 0; index < 100 && !ui.textContent?.includes('Validation findings'); index++) await advance(20);
  assert.ok(ui.textContent?.includes('Validation findings'));
  assert.ok(ui.textContent?.includes('Revision not associated'));
  // The building has no IFC GUID; clicking it follows retained links. Revision
  // records remain unscoped, so it cannot silently guess an installation.
  click(button('Pilot building'));
  assert.equal(useViewerStore.getState().selectedEntityIds.size, 0);
  act(() => createSelectionAdapter(useViewerStore).set([{ modelId: 'm0', expressId: authored.doors[0] }]));
  click(ui.querySelector('input[type=checkbox]')!);
  assert.ok(!ui.querySelector('tbody')?.textContent?.includes('Incomplete passport: missing product and granularity'));
  // Load a deliberate single-model view without revision claims, then drive
  // the actual row buttons. A batch selects two doors; an installation one.
  click(ui.querySelector('input[type=checkbox]')!);
  const withoutRevision = pilotDocument();
  withoutRevision.resources = withoutRevision.resources.filter(record => !record.id.endsWith('previous'))
    .map(record => { const { modelRevision: _revision, ...value } = record; return value; });
  input(ui.querySelector('textarea')!, JSON.stringify(withoutRevision));
  click(button('Load records'));
  for (let index = 0; index < 100 && ui.querySelector('tbody')?.textContent?.includes('Previous revision door'); index++) await advance(20);
  click(button('Shared door batch'));
  assert.equal(useViewerStore.getState().selectedEntityIds.size, 2);
  click(button('Installed door 1'));
  assert.deepEqual(createSelectionAdapter(useViewerStore).get(), [{ modelId: 'm0', expressId: authored.doors[0] }]);
  cleanup();
  const reopened = render(<SemanticPanel />);
  assert.ok(reopened.querySelector('tbody')?.textContent?.includes('Installed door 1'));
});
test('authored pilot doors produce real WASM meshes in both revision positions', async () => {
  const { default: init } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url)) });
  const centers: number[] = [];
  for (const revision of [0, 1]) {
    const model = pilotModel(revision); const processor = new GeometryProcessor();
    try {
      await processor.init();
      const { meshes } = await processor.process(new TextEncoder().encode(model.content));
      const doors = meshes.filter(mesh => model.doors.includes(mesh.expressId));
      assert.equal(new Set(doors.map(mesh => mesh.expressId)).size, 3);
      assert.ok(doors.every(mesh => mesh.indices.length > 0 && mesh.positions.every(Number.isFinite)));
      const mesh = doors.find(mesh => mesh.expressId === model.doors[0])!;
      // IFC Y maps to viewer -Z. Revisions are separated by three metres.
      const z = Array.from(mesh.positions).filter((_, index) => index % 3 === 2);
      centers.push((Math.min(...z) + Math.max(...z)) / 2 + (mesh.origin?.[2] ?? 0));
    } finally { processor.dispose(); }
  }
  assert.ok(Math.abs(Math.abs(centers[1] - centers[0]) - 3) < 0.01);
});
test('overlay-created addresses remain selectable outside the parsed range in single and federated models', async () => {
  for (const count of [1, 2]) {
    await seed(count);
    const id = count === 2 ? 'm1' : 'm0';
    const data = useViewerStore.getState().models.get(id)!.ifcDataStore!;
    const view = new MutablePropertyView(data.properties, id);
    view.setExpressIdWatermark(Math.max(...data.entities.expressId));
    const GlobalId = '0000000000000000000777';
    view.createEntity('IfcDoor', [`'${GlobalId}'`, null, "'Created door'"]);
    useViewerStore.getState().registerMutationView(id, view);
    const entity = liveEntities().find(record => record.GlobalId === GlobalId)!;
    assert.ok(entity); assert.equal(entity.modelId, id);
    assert.ok(entity.expressId > Math.max(...data.entities.expressId));
    createSelectionAdapter(useViewerStore).set([entity]);
    assert.deepEqual(createSelectionAdapter(useViewerStore).get(), [{ modelId: id, expressId: entity.expressId }]);
    view.deleteEntity(entity.expressId);
    assert.equal(createSelectionAdapter(useViewerStore).get().length, 0);
  }
});
test('imports cannot replace the installed profile and cyclic passport links cannot loop selection', () => {
  const document = pilotDocument();
  assert.deepEqual(parseImport({ document, shapesTurtle: 'untrusted remote shapes' }), document);
  assert.throws(() => parseImport({ ...document, profile: 'https://example.org/another-profile' }));
  const passport = { id: DEMO_BASE + 'cycle', type: 'Passport' as const, label: 'Cycle', productId: DEMO_BASE + 'cycle' };
  assert.equal(selectionTargets([passport], passport).length, 0);
  assert.equal(validateLinks({ ...document, completeness: 'partial', resources: [passport] }).length, 1);
  const did = { ...document, resources: [{ id: 'did:example:building', type: 'Building' as const, label: 'DID identified building' }] };
  assert.equal(parseDocument(did).resources[0].id, 'did:example:building');
});
