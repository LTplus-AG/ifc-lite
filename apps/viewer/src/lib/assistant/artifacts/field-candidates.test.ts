/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ambiguity against the committed samples (viewer AI P13, #6914): a name a
 * proposal uses either exists exactly in the loaded models or is unresolved
 * with real candidates, ranked by similarity then presence; never guessed.
 * `building-architecture.ifc` has FireRating only in Pset_SlabCommon (on the
 * `floor` slab), not in Pset_WallCommon.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { useViewerStore } from '@/store';
import { seedArtifactModels, ARCH, WALL } from '@/test/artifact-models-fixture';
import { parseArtifactProposal } from './proposal-kinds';
import { fieldSites } from './field-refs';
import { resolveFields, similarity } from './field-candidates';
import { buildModelSchemaIndex, modelSchemaIndex } from './model-schema';
import { schemaDigest, artifactGuidance, ARTIFACT_OUTPUT_GUIDANCE, DIGEST_LIMIT } from './artifact-guidance';

before(async () => { await seedArtifactModels({ federated: true }); });

const listWith = (columns: unknown[], groups: unknown[] = []) => parseArtifactProposal(JSON.stringify({ version: 1, kind: 'list.proposal', title: 'T',
  list: { name: 'L', entityTypes: ['IfcWall'], groups, columns } }), 'list.proposal');

test('the schema index counts elements per exact set and name, per model', async () => {
  const index = await modelSchemaIndex(useViewerStore.getState());
  const external = index.fields.get(`property:${JSON.stringify(['Pset_WallCommon', 'IsExternal'])}`);
  assert.deepEqual([...(external?.byModel ?? [])], [[ARCH, 4], [WALL, 1]]);
  assert.equal(index.fields.get(`quantity:${JSON.stringify(['Qto_WallBaseQuantities', 'NetSideArea'])}`)?.count, 4);
  assert.equal(index.classes.get('IfcWall'), 5);
  assert.equal(await modelSchemaIndex(useViewerStore.getState()), index, 'cached for the same federation and revision');
});

test('the schema scan yields between chunks and a newer revision can abandon it', async () => {
  // A timer queued before the scan runs while it is still scanning: the viewer is never blocked for the whole scan.
  const order: string[] = [];
  setTimeout(() => order.push('timer'), 0);
  const chunked = await buildModelSchemaIndex(useViewerStore.getState(), { chunk: 4 }).then((index) => { order.push('scan'); return index; });
  assert.deepEqual(order, ['timer', 'scan']);
  assert.deepEqual([...chunked.fields.keys()], [...(await modelSchemaIndex(useViewerStore.getState())).fields.keys()], 'chunking changes no count');
  const controller = new AbortController();
  const abandoned = buildModelSchemaIndex(useViewerStore.getState(), { chunk: 4, signal: controller.signal });
  controller.abort();
  await assert.rejects(abandoned, { name: 'AbortError' });
});

test('an exact name resolves; a missing one lists the candidates the models carry, best first', async () => {
  const proposal = listWith([
    { id: 'area', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetSideArea' },
    { id: 'rating', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating' }]);
  const [area, rating] = resolveFields(fieldSites(proposal), (await modelSchemaIndex(useViewerStore.getState())));
  assert.equal(area.status, 'exact');
  assert.equal(rating.status, 'unresolved');
  assert.ok(rating.status === 'unresolved');
  assert.deepEqual([rating.candidates[0].set, rating.candidates[0].name, rating.candidates[0].count], ['Pset_SlabCommon', 'FireRating', 1]);
  assert.ok(rating.candidates.every((candidate) => candidate.kind === 'property'), 'a property is never offered a quantity in its place');
  assert.ok(rating.candidates.length <= 6);
});

test('a case-only difference is still a pick, never a silent match', async () => {
  const proposal = listWith([{ id: 'area', source: 'quantity', psetName: 'qto_wallbasequantities', propertyName: 'netsidearea' }]);
  const [area] = resolveFields(fieldSites(proposal), (await modelSchemaIndex(useViewerStore.getState())));
  assert.ok(area.status === 'unresolved');
  assert.deepEqual([area.candidates[0].set, area.candidates[0].name], ['Qto_WallBaseQuantities', 'NetSideArea']);
  assert.equal(area.candidates[0].score, 1);
});

test('picking a candidate rewrites exactly that reference in the native shape', async () => {
  const proposal = listWith([{ id: 'rating', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'Fire Rating' }],
    [{ combinator: 'AND', rules: [{ kind: 'property', setName: 'Pset_WallCommon', propertyName: 'Fire Rating', op: 'isSet' }] }]);
  const sites = fieldSites(proposal);
  // Structured, so the review card words it in the user's language (#6914 review).
  assert.deepEqual(sites.map((site) => site.where), [{ kind: 'rule', group: 1, rule: 1 }, { kind: 'column', column: 'rating' }]);
  const next = sites.reduce((current, site) => site.replace(current, 'Pset_SlabCommon', 'FireRating'), proposal);
  assert.ok(next.kind === 'list.proposal');
  assert.deepEqual(next.list.columns[0], { id: 'rating', source: 'property', psetName: 'Pset_SlabCommon', propertyName: 'FireRating' });
  const rule = next.list.groups[0].rules[0];
  assert.ok(rule.kind === 'property' && rule.setName === 'Pset_SlabCommon' && rule.propertyName === 'FireRating');
  assert.ok(proposal.kind === 'list.proposal' && proposal.list.columns[0].psetName === 'Pset_WallCommon', 'the original stays untouched');
  assert.ok(resolveFields(fieldSites(next), (await modelSchemaIndex(useViewerStore.getState()))).every((r) => r.status === 'exact'));
});

test('chart and lens fields are checked like filter and list fields', async () => {
  const chart = parseArtifactProposal(JSON.stringify({ version: 1, kind: 'chart.proposal', title: 'T', chart: { type: 'bar', dimension: 'Storey',
    measure: { agg: 'sum' }, measureField: { kind: 'quantity', qsetName: 'Qto_SlabBaseQuantities', quantityName: 'GrossArea' } } }), 'chart.proposal');
  const [measure] = resolveFields(fieldSites(chart), (await modelSchemaIndex(useViewerStore.getState())));
  assert.ok(measure.status === 'unresolved' && measure.candidates[0].name === 'NetArea');
  const lens = parseArtifactProposal(JSON.stringify({ version: 1, kind: 'lens.proposal', title: 'T', lens: { name: 'L',
    autoColor: { source: 'property', psetName: 'Pset_SlabCommon', propertyName: 'FireRating' } } }), 'lens.proposal');
  assert.equal(resolveFields(fieldSites(lens), (await modelSchemaIndex(useViewerStore.getState())))[0].status, 'exact');
});

test('similarity folds case and separators', () => {
  assert.equal(similarity('FireRating', 'Fire Rating'), 1);
  assert.ok(similarity('NetSideArea', 'NetArea') > similarity('NetSideArea', 'Width'));
});

test('guidance carries the contract and a bounded digest of exact names, not the whole index', async () => {
  const index = (await modelSchemaIndex(useViewerStore.getState()));
  const digest = schemaDigest(index);
  assert.match(digest, /building-architecture\.ifc \(14 elements\)/);
  assert.match(digest, /Pset_SlabCommon\.FireRating 1/);
  assert.match(digest, /Qto_WallBaseQuantities\.NetSideArea 4/);
  assert.ok(digest.length <= DIGEST_LIMIT + 200);
  const guidance = await artifactGuidance(useViewerStore.getState());
  assert.ok(guidance.startsWith(ARTIFACT_OUTPUT_GUIDANCE));
  for (const kind of ['filter.proposal', 'list.proposal', 'lens.proposal', 'chart.proposal']) assert.ok(guidance.includes(kind));
});

test('an unreadable model never fails the request: the contract goes out without the digest, and the reason is logged', async (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  // A store the field reader cannot open (no schema version), as a partially initialised model would be.
  const broken = { models: new Map([['x', { name: 'x.ifc', ifcDataStore: {} }]]), mutationViews: new Map(), mutationVersion: 0 };
  const guidance = await artifactGuidance(broken as unknown as Parameters<typeof artifactGuidance>[0]);
  assert.ok(guidance.startsWith(ARTIFACT_OUTPUT_GUIDANCE));
  assert.match(guidance, /Model schema: unavailable/);
  assert.equal(warn.mock.callCount(), 1);
});
