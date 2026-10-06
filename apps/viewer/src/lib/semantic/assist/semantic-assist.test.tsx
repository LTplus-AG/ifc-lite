/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { seedSemanticModels } from '@/test/semantic-model-fixture';
import { captureEvidence, evidenceIsCurrent } from '@/lib/assistant/evidence';
import { createQueryAdapter } from '@/sdk/adapters/query-adapter';
import { DEMO_REVISIONS } from '../demo';
import { useSemanticSession } from '../session';
import { useSemanticEndpointGrant, recordEndpointGrant, revokeEndpointGrant } from './endpoint-grant';
import { attachSourceText, useSemanticSourceTexts } from './source-texts';
import { capturedPassages, passagesOf } from './spans';
import { discloseGrant, runReviewedQuery } from './query-run';
import { parseSemanticQuery } from './query-proposal';
import { parseSemanticMapping } from './mapping-proposal';
import { reviewSemanticMapping } from './mapping-review';
import { parseSemanticProjection } from './projection-proposal';
import { applySemanticProjections, previewSemanticProjection } from './projection-review';
import { captureRevisionPin, revisionPinIsCurrent } from './revision-pin';
import { PROFILE_ID } from '../types';
import { semanticAdapter } from '@/lib/assistant/adapters/semantic';

const original = useViewerStore.getState();
const session = useSemanticSession.getState();
afterEach(() => {
  useViewerStore.setState(original, true); useSemanticSession.setState(session, true);
  useSemanticSourceTexts.setState({ sources: [] }); revokeEndpointGrant();
});

const SECRET = 'bearer-secret-7d1f';
const ENDPOINT = 'https://graph.private-endpoint.example/sparql/v2';
const grant = { endpoint: ENDPOINT, host: 'graph.private-endpoint.example', relayProvider: 'relay-private', bearer: SECRET };
const SPEC = 'Scope of works\n\nDoors in escape routes shall have a fire rating of EI30.\n\nAcoustic: at least 35 dB.';

test('#6920 assistant evidence exposes records and exact passages but never endpoint, grants, relay or credential', async () => {
  await seedSemanticModels();
  attachSourceText('Door specification', SPEC);
  recordEndpointGrant(grant);
  const snapshot = captureEvidence('semantic');
  assert.equal(snapshot.source, 'semantic');
  for (const forbidden of [SECRET, ENDPOINT, 'private-endpoint', 'relay-private', 'sparql/v2']) {
    assert.ok(!snapshot.payload.includes(forbidden), `payload must not contain ${forbidden}`);
  }
  assert.match(snapshot.payload, /"endpointGrant":"available"/);
  // The captured passages are exactly what the assistant could quote from.
  assert.deepEqual(capturedPassages(snapshot.payload), passagesOf('S1', SPEC));
  assert.match(snapshot.payload, /Installed door 1/);
  // Attaching another text is a new evidence identity, so earlier conversations show as stale.
  assert.equal(evidenceIsCurrent(snapshot), true);
  attachSourceText('Second', 'More text');
  assert.equal(evidenceIsCurrent(snapshot), false);
});

test('#6920 a grant reaches a reviewer only as a disclosure without the credential, and any source change revokes it', () => {
  recordEndpointGrant({ ...grant, loopbackHttpOrigin: 'http://127.0.0.1:3000' });
  const disclosure = discloseGrant(useSemanticEndpointGrant.getState().grant!);
  assert.deepEqual(Object.keys(disclosure).sort(), ['credential', 'endpoint', 'host', 'loopback', 'relay']);
  assert.equal(disclosure.credential, true);
  assert.ok(!JSON.stringify(disclosure).includes(SECRET));
  revokeEndpointGrant();
  assert.equal(useSemanticEndpointGrant.getState().grant, null);
});

const QUERY = { version: 1, kind: 'semantic.query', title: 'Doors', purpose: 'List installed doors', expected: { form: 'select', columns: ['id', 'GlobalId', 'modelRevision'] },
  query: 'SELECT ?id ?GlobalId ?modelRevision WHERE { ?id ?p ?GlobalId } LIMIT 50' };
function selectResponse(rows: Array<Record<string, string>>) {
  return new Response(JSON.stringify({ head: { vars: ['id', 'GlobalId', 'modelRevision'] },
    results: { bindings: rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, { type: key === 'id' ? 'uri' : 'literal', value }]))) } }),
  { status: 200, headers: { 'content-type': 'application/sparql-results+json' } });
}

test('#6920 a reviewed query runs only with the exercised grant, resolves rows against the pinned revision and turns historical when it changes', async () => {
  const { document } = await seedSemanticModels();
  const installations = document.resources.filter(resource => resource.type === 'Installation' && resource.modelRevision === DEMO_REVISIONS[0]);
  const calls: Array<{ url: string; authorization: string | null; body: string }> = [];
  const transport = async (url: URL, init: RequestInit) => {
    calls.push({ url: url.href, authorization: new Headers(init.headers).get('authorization'), body: String(init.body) });
    return selectResponse([...installations.map(item => ({ id: item.id, GlobalId: String(item.GlobalId), modelRevision: DEMO_REVISIONS[0] })),
      { id: 'https://example.org/none', GlobalId: '0000000000000000000999', modelRevision: DEMO_REVISIONS[0] }]);
  };
  const proposal = parseSemanticQuery(JSON.stringify(QUERY));
  const run = await runReviewedQuery(proposal, { ...grant, grantedAt: 'now' }, undefined, transport);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, `Bearer ${SECRET}`, 'the credential is used only as the request header');
  assert.ok(!calls[0].body.includes(SECRET));
  assert.equal(run.source, ENDPOINT);
  assert.equal(run.result.form, 'select');
  assert.deepEqual(run.result.form === 'select' && run.result.statuses, ['resolved', 'resolved', 'resolved', 'unmatched']);
  assert.ok(!JSON.stringify(run).includes(SECRET));
  // Historical once the model associations change; current again when restored.
  const revisions = useSemanticSession.getState().revisions;
  assert.equal(revisionPinIsCurrent(run.pin), true);
  useSemanticSession.setState({ revisions: new Map([[DEMO_REVISIONS[0], 'm1']]) });
  assert.equal(revisionPinIsCurrent(run.pin), false);
  useSemanticSession.setState({ revisions });
  assert.equal(revisionPinIsCurrent(run.pin), true);
  // A proposal that fails native lint never reaches the network, even with a grant.
  const refused = parseSemanticQuery(JSON.stringify({ ...QUERY, query: QUERY.query.replace(' LIMIT 50', '') }));
  await assert.rejects(runReviewedQuery(refused, { ...grant, grantedAt: 'now' }, undefined, transport), /did not pass review.*outer LIMIT/);
  assert.equal(calls.length, 1);
});

test('#6920 a granted host is still enforced natively: another host is refused before any request', async () => {
  await seedSemanticModels();
  let called = false;
  const proposal = parseSemanticQuery(JSON.stringify(QUERY));
  await assert.rejects(runReviewedQuery(proposal, { endpoint: 'https://other.example/sparql', host: 'graph.private-endpoint.example', grantedAt: 'now' }, undefined,
    async () => { called = true; return selectResponse([]); }));
  assert.equal(called, false);
});

const REVISION = DEMO_REVISIONS[0];
const mappingProposal = (mappings: object[]) => parseSemanticMapping(JSON.stringify({ version: 1, kind: 'semantic.mapping', title: 'Doors', modelRevision: REVISION, mappings }));

test('#6920 mapping review counts live elements per associated revision and blocks unknown terms and unverified spans', async () => {
  await seedSemanticModels(2);
  attachSourceText('Specification', SPEC);
  const passages = passagesOf('S1', SPEC);
  const start = SPEC.indexOf('fire rating of EI30'); const end = start + 'fire rating of EI30'.length;
  const good = { source: 'S1', start, end, quote: 'fire rating of EI30' };
  const proposal = mappingProposal([
    { ifc: { class: 'IfcDoor', pset: 'Pset_DoorCommon', property: 'FireRating' }, ontology: { property: 'fireRating' }, confidence: 0.9, sources: [good] },
    { ifc: { class: 'IfcDoor' }, ontology: { class: 'https://example.org/ontology/Door' }, confidence: 0.5, sources: [] },
    { ifc: { class: 'IfcWall' }, ontology: { class: 'Installation' }, confidence: 0.5, sources: [good] },
    { ifc: { class: 'IfcDoor', pset: 'Pset_DoorCommon', property: 'FireRating' }, ontology: { property: 'not a term' }, confidence: 0.5, sources: [good] },
    { ifc: { class: 'IfcDoor', pset: 'Pset_DoorCommon', property: 'Material' }, ontology: { property: 'fireRating' }, confidence: 0.5, sources: [{ ...good, start: start - 2, end: end - 2 }] },
    { ifc: { class: 'IfcDoor', pset: 'Pset_DoorCommon', property: 'Acoustic' }, ontology: { property: 'fireRating' }, confidence: 0.5, sources: [{ source: 'S1', start: 5000, end: 5004, quote: 'abcd' }] },
  ]);
  const review = reviewSemanticMapping(proposal, { profile: useSemanticSession.getState().profile, revisions: useSemanticSession.getState().revisions, passages });
  assert.equal(review.modelId, 'm0');
  // Both models hold the same 3 doors: only the model associated with the revision is counted.
  assert.deepEqual(review.rows.map(row => row.elements), [3, 3, 0, 3, 3, 3]);
  assert.deepEqual(review.rows.map(row => row.approvable), [true, true, true, false, false, false]);
  assert.deepEqual(review.rows.map(row => row.issues), [[], ['external-term', 'unsourced'], ['class-absent'], ['unknown-term'], ['span-mismatch'], ['span-not-captured']]);
  assert.equal(review.rows[0].propertyTerm?.status, 'profile');
  assert.equal(review.rows[1].classTerm?.status, 'external');
  // Without an associated revision nothing is approvable: the mapping has no model scope.
  const unscoped = reviewSemanticMapping(proposal, { profile: useSemanticSession.getState().profile, revisions: new Map(), passages });
  assert.equal(unscoped.modelId, null);
  assert.ok(unscoped.rows.every(row => !row.approvable && row.elements === 0));
  // The review reads the model and changes nothing.
  assert.equal(createQueryAdapter(useViewerStore).entities({ types: ['IfcDoor'] }).length, 6);
});

test('#6920 a revision pin records the loaded sources and is current only while they are the same', async () => {
  await seedSemanticModels(2);
  const pin = captureRevisionPin();
  assert.deepEqual(pin.associations.map(item => [item.revision, item.modelId]), [[DEMO_REVISIONS[0], 'm0'], [DEMO_REVISIONS[1], 'm1']]);
  assert.equal(revisionPinIsCurrent(pin), true);
  const models = new Map(useViewerStore.getState().models); models.delete('m1');
  useViewerStore.setState({ models });
  assert.equal(revisionPinIsCurrent(pin), false);
});

test('#6920 projection rows go through the native service: refusals verbatim, stale previews refused, applying writes provenance', async () => {
  const { document, revisions } = await seedSemanticModels(1);
  useViewerStore.setState({ editEnabled: true });
  const rows = (items: object[]) => previewSemanticProjection(parseSemanticProjection(JSON.stringify({ version: 1, kind: 'semantic.projection', title: 'P', projections: items })),
    { document, profile: useSemanticSession.getState().profile, revisions, retrievedAt: '2026-01-01T00:00:00.000Z' });
  const one = document.resources.find(resource => resource.id.endsWith('installation/1'))!;
  const [ready, missing, unknown] = rows([{ resource: one.id, field: 'fireRating', policy: 'overwrite' },
    { resource: 'https://example.org/nope', field: 'fireRating' }, { resource: one.id, field: 'colour' }]);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.status === 'ready' && ready.plan.value, 'EI30');
  assert.deepEqual([missing.status === 'refused' && missing.reason, unknown.status === 'refused' && unknown.reason],
    ['The installation record is not in the loaded records', 'No native projection mapping exists for this field']);
  assert.ok(ready.status === 'ready');
  const results = applySemanticProjections([ready.plan], revisions);
  assert.equal(results[0].error, undefined);
  const properties = JSON.stringify(createQueryAdapter(useViewerStore).properties(ready.plan.ref));
  assert.ok(properties.includes('EI30') && properties.includes('Pset_SemanticProjection') && properties.includes(PROFILE_ID));
  // The same plan is now stale: the property changed under it, and a second apply is refused.
  assert.match(applySemanticProjections([ready.plan], revisions)[0].error ?? '', /stale/);
  // With editing off the native service denies every row instead of the card writing around it.
  useViewerStore.setState({ editEnabled: false });
  assert.ok(rows([{ resource: one.id, field: 'fireRating' }]).every(row => row.status === 'refused' && /denied/i.test(row.reason)));
});

test('#6920 an attached text alone is attachable evidence, with revisions and profile terms but no records', async () => {
  await seedSemanticModels(1);
  useSemanticSession.setState({ document: undefined });
  const state = useViewerStore.getState();
  assert.deepEqual(semanticAdapter.readiness(state), { status: { labelKey: 'assistantSources.semantic.none' }, ready: false });
  assert.equal(semanticAdapter.capture(state, 100).availability, 'unavailable');
  attachSourceText('Specification', SPEC);
  assert.deepEqual(semanticAdapter.readiness(state), { status: { labelKey: 'semanticAssist.pickTexts', params: { count: 1 } }, ready: true });
  const capture = semanticAdapter.capture(state, 100);
  assert.equal(capture.availability, 'available');
  assert.deepEqual(capture.rows, passagesOf('S1', SPEC));
  assert.equal(capture.totalRows, 3);
  const assist = (capture.summary as { assist: { revisions: unknown[]; profile: { fields: Array<{ key: string }> }; projectionMappings: Array<{ field: string }> } }).assist;
  assert.deepEqual(assist.revisions, [{ revision: DEMO_REVISIONS[0], associatedWithLoadedModel: true }]);
  assert.ok(assist.profile.fields.some(field => field.key === 'fireRating'));
  assert.ok(assist.projectionMappings.some(mapping => mapping.field === 'fireRating'));
});
