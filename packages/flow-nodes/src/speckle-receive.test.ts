/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `speckle.receive` (#5634 / #5167 phase 3.6), end to end through
 * `runFlow` and the standard registry: the hand-authored corpus is replayed
 * by `__tests__/speckle-server.ts` through the host's injected
 * `networkTransport`, and the assertions read what landed in the model.
 */

import { describe, expect, it } from 'vitest';
import { parseCapabilities } from '@ifc-lite/extensions';
import { runFlow, trackingGuid, type FlowDocument, type FlowNode } from '@ifc-lite/flow';
import { createFakeBim, type FakeHost } from './__tests__/fake-backend.js';
import { CORPUS_HOST, CORPUS_PROJECT, corpusObjects, speckleServer, type SpeckleServer } from './__tests__/speckle-server.js';
import { createStandardRegistry, headlessFeatures } from './index.js';

const registry = createStandardRegistry();
const MODEL_URL = `https://${CORPUS_HOST}/projects/${CORPUS_PROJECT}/models/m1`;
const APP = '0d3c1f2a-5e6b-4c7d-8e9f-a0b1c2d3e4f5-';
// Entered only through the registry (no import of the node module): the
// documented identity scope is "speckle:<server origin>/<project>".
const guidOn = (host: string, elementId: string) => trackingGuid(`speckle:https://${host}/${CORPUS_PROJECT}`, `${APP}${elementId}`);
const guidOf = (elementId: string) => guidOn(CORPUS_HOST, elementId);

function grants(...raw: string[]) {
  const r = parseCapabilities(raw);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('; '));
  return r.value;
}

/** A fake model with ONE storey (EG, #1), so the receive runs as a single lane. */
function oneStoreyBim(): FakeHost {
  const fake = createFakeBim();
  fake.entities.splice(fake.entities.findIndex((e) => e.globalId === 'S2'), 1);
  return fake;
}

function receiveDoc(params: Record<string, unknown>): FlowDocument {
  const nodes: FlowNode[] = [
    { id: 'storey', type: 'model.byType', params: { type: 'IfcBuildingStorey' } },
    { id: 'rx', type: 'speckle.receive', params },
  ];
  return {
    flowVersion: 1, id: 'g', name: 'g', capabilities: [], inputs: [], nodes,
    edges: [{ from: ['storey', 'entities'], to: ['rx', 'storey'] }],
    outputs: [
      { nodeId: 'rx', port: 'entities', label: 'entities' },
      { nodeId: 'rx', port: 'refusals', label: 'refusals' },
      { nodeId: 'rx', port: 'versionId', label: 'versionId' },
    ],
  };
}

async function receive(fake: FakeHost, server: SpeckleServer, params: Record<string, unknown>, hosts = [CORPUS_HOST], modelGrants?: string[]) {
  return runFlow(receiveDoc(params), {
    host: {
      bim: fake.bim,
      networkGrants: grants(...hosts.map((h) => `network.fetch:${h}`)),
      networkTransport: server.transport,
      grants: modelGrants ? grants(...modelGrants) : undefined,
    },
    registry,
    features: headlessFeatures(),
  });
}

interface Refusal { speckleType: string; reason: string; count: number; message: string; examples: string[] }

function refusalsOf(r: Awaited<ReturnType<typeof runFlow>>): Refusal[] {
  const lane = r.outputs.get('rx')?.get('refusals');
  if (lane?.kind !== 'list') throw new Error(`expected a lifted list, got ${lane?.kind}`);
  return lane.items[0] as Refusal[];
}

/** A lane's failure: the scheduler logs it and counts it, the run itself stays ok. */
function laneError(r: Awaited<ReturnType<typeof runFlow>>): string | undefined {
  expect(r.reports.find((x) => x.nodeId === 'rx')?.laneErrors).toBe(1);
  return r.log.find((l) => l.nodeId === 'rx' && l.level === 'error')?.message;
}

const summary = (refusals: Refusal[]) => refusals.map((x) => `${x.speckleType} ${x.reason} ${x.count}`).sort();

describe('speckle.receive (#5634)', () => {
  it('is registered as a volatile, network-requiring, model-writing node', () => {
    const def = registry.get('speckle.receive');
    expect(def?.volatile).toBe(true);
    expect(def?.requires?.network).toBe(true);
    expect(def?.writes).toBe('model');
    expect(def?.capabilities).toEqual([
      'model.create', 'model.delete',
      'model.mutate:Speckle_Source', 'model.mutate:Speckle_TypeParameters', 'model.mutate:Speckle_InstanceParameters',
      'network.fetch:*',
    ]);
  });

  it('replays the corpus: every mappable element lands in the storey with SI dimensions', async () => {
    const fake = oneStoreyBim();
    const server = speckleServer();
    const r = await receive(fake, server, { url: MODEL_URL });
    expect(r.reports.find((x) => x.nodeId === 'rx')?.laneErrors).toBe(0);

    const created = fake.created.map((c) => ({ builder: c.builder, storey: c.storey, ...c.params }));
    expect(created).toEqual([
      { builder: 'addWall', storey: 1, Name: 'Basic Wall: Generic - 200mm', ObjectType: 'Generic - 200mm', Tag: '300101', Start: [0, 0, 0], End: [6, 0, 0], Height: 3, Thickness: 0.2, GlobalId: guidOf('300101') },
      { builder: 'addWall', storey: 1, Name: 'Basic Wall: Generic - 200mm', ObjectType: 'Generic - 200mm', Tag: '300102', Start: [6, 0, 0], End: [6, 4, 0], Height: 3, Thickness: 0.2, GlobalId: guidOf('300102') },
      {
        builder: 'addSlab', storey: 1, Name: 'Floor: Concrete 250mm', ObjectType: 'Concrete 250mm', Tag: '300201', Profile: 'polygon',
        OuterCurve: [[0, 0], [6, 0], [6, 4], [0, 4]], Position: [0, 0, -0.25], Thickness: 0.25, GlobalId: guidOf('300201'),
      },
      { builder: 'addColumn', storey: 1, Name: 'Concrete-Rectangular-Column: 400 x 400mm', ObjectType: '400 x 400mm', Tag: '300301', Position: [3, 2, 0], Height: 3, Width: 0.4, Depth: 0.4, GlobalId: guidOf('300301') },
      // Level 2 (elevation 3000 mm): coordinates are made relative to the element's own level.
      { builder: 'addBeam', storey: 1, Name: 'Concrete-Rectangular Beam: 300 x 600mm', ObjectType: '300 x 600mm', Tag: '300401', Start: [0, 2, 0], End: [6, 2, 0], Width: 0.3, Height: 0.6, GlobalId: guidOf('300401') },
      {
        builder: 'addRoof', storey: 1, Name: 'Basic Roof: Warm Roof - Concrete', ObjectType: 'Warm Roof - Concrete', Tag: '300501', Profile: 'polygon',
        OuterCurve: [[0, 0], [6, 0], [6, 4], [0, 4]], Position: [0, 0, 0], Thickness: 0.3, GlobalId: guidOf('300501'),
      },
    ]);
    const entities = r.outputs.get('rx')?.get('entities');
    if (entities?.kind !== 'group') throw new Error(`expected entities grouped by storey lane, got ${entities?.kind}`);
    expect((entities.branches.get('S1') as Array<{ globalId: string }>).map((e) => e.globalId)).toEqual(
      ['300101', '300102', '300201', '300301', '300401', '300501'].map(guidOf),
    );
  });

  it('carries parameters as property sets, converting lengths, areas and volumes to SI', async () => {
    const fake = oneStoreyBim();
    await receive(fake, speckleServer(), { url: MODEL_URL });
    const wall = fake.entities.find((e) => e.globalId === guidOf('300101'));
    expect(wall?.psets.Speckle_Source).toEqual({
      SpeckleId: corpusObjects().find((o) => o.applicationId === `${APP}300101`)?.id,
      SpeckleType: 'Objects.BuiltElements.Wall:Objects.BuiltElements.Revit.RevitWall',
      ApplicationId: `${APP}300101`, Category: 'Walls', Family: 'Basic Wall', Type: 'Generic - 200mm', ElementId: '300101', Level: 'Level 1', SourceUnits: 'mm',
    });
    expect(wall?.psets.Speckle_TypeParameters).toEqual({ Width: 0.2, Function: 'Exterior', 'Type Name': 'Generic - 200mm' });
    expect(wall?.psets.Speckle_InstanceParameters).toMatchObject({ Length: 6, Area: 18, Volume: 3.6, 'Unconnected Height': 3, Mark: 'W-w1', 'Base Constraint': 'Level 1' });
    const slab = fake.entities.find((e) => e.globalId === guidOf('300201'));
    expect(slab?.psets.Speckle_InstanceParameters).toMatchObject({ Thickness: 0.25, Perimeter: 20, Structural: true });
    // The beam uses the connector's older `parameters` map; both shapes read the same way.
    const beam = fake.entities.find((e) => e.globalId === guidOf('300401'));
    expect(beam?.psets.Speckle_TypeParameters).toEqual({ b: 0.3, h: 0.6 });
    expect(beam?.psets.Speckle_InstanceParameters).toEqual({ Length: 6, Mark: 'B-1', Volume: 1.08 });
  });

  it('refuses what v1 cannot map, by type, reason and count', async () => {
    const r = await receive(oneStoreyBim(), speckleServer(), { url: MODEL_URL });
    expect(summary(refusalsOf(r))).toEqual([
      'RevitBeam display-meshes 1',
      'RevitColumn display-meshes 1',
      'RevitElement unmapped-type 1',
      'RevitFloor display-meshes 1',
      'RevitFloor non-parameter-entries 2',
      'RevitFloor openings 1',
      'RevitFootprintRoof display-meshes 1',
      'RevitWall display-meshes 2',
      'RevitWall geometry 1',
    ]);
    const arc = refusalsOf(r).find((x) => x.reason === 'geometry');
    expect(arc?.message).toBe('1 RevitWall object not written: has an Arc location, not a straight line.');
    expect(arc?.examples).toEqual([corpusObjects().find((o) => o.applicationId === `${APP}300103`)?.id]);
  });

  it('never downloads display geometry', async () => {
    const server = speckleServer();
    await receive(oneStoreyBim(), server, { url: MODEL_URL });
    const types = new Map(corpusObjects().map((o) => [o.id, o.speckle_type]));
    expect(server.served.filter((id) => types.get(id) === 'Objects.Geometry.Mesh')).toEqual([]);
    // One DataChunk IS fetched: the roof's chunked polyline outline, which the mapping reads.
    expect(server.served.filter((id) => types.get(id) === 'Speckle.Core.Models.DataChunk')).toHaveLength(1);
    expect(server.requests.map((q) => `${q.method} ${new URL(q.url).pathname}`)).toEqual([
      'POST /graphql',
      `GET /objects/${CORPUS_PROJECT}/${server.rootId}/single`,
      ...Array(server.requests.length - 2).fill(`POST /api/getobjects/${CORPUS_PROJECT}`),
    ]);
  });

  it('resolves a pinned version by id, and a legacy object URL without GraphQL', async () => {
    const pinned = speckleServer();
    const r = await receive(oneStoreyBim(), pinned, { url: `${MODEL_URL}@a1b2c3d4e5` });
    expect(JSON.parse(pinned.requests[0].body ?? '{}').variables).toEqual({ projectId: CORPUS_PROJECT, versionId: 'a1b2c3d4e5' });
    expect(r.outputs.get('rx')?.get('versionId')).toEqual({ kind: 'list', items: ['a1b2c3d4e5'] });

    const legacy = speckleServer();
    const fake = oneStoreyBim();
    await receive(fake, legacy, { url: `https://${CORPUS_HOST}/streams/${CORPUS_PROJECT}/objects/${legacy.rootId}` });
    expect(legacy.requests.some((q) => q.url.endsWith('/graphql'))).toBe(false);
    expect(fake.created).toHaveLength(6);
  });

  it('refuses an ungranted host before any request is made', async () => {
    const fake = oneStoreyBim();
    const server = speckleServer();
    const r = await receive(fake, server, { url: MODEL_URL }, ['other.example.com']);
    expect(laneError(r)).toMatch(/network\.fetch refused: host "speckle\.example\.com"/);
    expect(server.requests).toEqual([]);
    expect(fake.created).toEqual([]);
  });

  it('sends the token as a bearer header on every request, and none without one', async () => {
    const withToken = speckleServer();
    await receive(oneStoreyBim(), withToken, { url: MODEL_URL, token: 'tok-5634' });
    expect(new Set(withToken.requests.map((q) => q.headers.authorization))).toEqual(new Set(['Bearer tok-5634']));
    const anonymous = speckleServer();
    await receive(oneStoreyBim(), anonymous, { url: MODEL_URL });
    expect(anonymous.requests.filter((q) => 'authorization' in q.headers)).toEqual([]);
  });

  it('a second receive replaces the elements of the first instead of duplicating them', async () => {
    const fake = oneStoreyBim();
    await receive(fake, speckleServer(), { url: MODEL_URL });
    await receive(fake, speckleServer(), { url: MODEL_URL });
    const received = fake.entities.filter((e) => e.expressId >= 1000);
    expect(received.map((e) => e.globalId)).toEqual(['300101', '300102', '300201', '300301', '300401', '300501'].map(guidOf));
    expect(fake.created).toHaveLength(12);
  });

  it('the level filter receives one level and reports the rest', async () => {
    const fake = oneStoreyBim();
    const r = await receive(fake, speckleServer(), { url: MODEL_URL, level: 'Level 2' });
    expect(fake.created.map((c) => c.builder)).toEqual(['addBeam', 'addRoof']);
    expect(summary(refusalsOf(r)).filter((s) => s.includes('other-level'))).toEqual([
      'RevitColumn other-level 1',
      'RevitFloor other-level 1',
      'RevitWall other-level 3',
    ]);
  });

  it('names a private project instead of mapping an empty answer', async () => {
    const r = await receive(oneStoreyBim(), speckleServer({ status: 401 }), { url: MODEL_URL });
    expect(laneError(r)).toMatch(/refused \(401\); the project is private or the token lacks access/);
  });

  it('stops at maxObjects rather than walking an unbounded graph', async () => {
    const fake = oneStoreyBim();
    const r = await receive(fake, speckleServer(), { url: MODEL_URL, maxObjects: 5 });
    expect(laneError(r)).toMatch(/more than maxObjects \(5\)/);
    expect(fake.created).toEqual([]);
  });

  it('a re-receive whose new write is rejected keeps the earlier element, and says so (#5925 review)', async () => {
    const fake = oneStoreyBim();
    await receive(fake, speckleServer(), { url: MODEL_URL });
    const before = fake.entities.filter((e) => e.type === 'IfcWall' && e.expressId >= 1000).map((e) => [e.globalId, e.expressId]);
    expect(before).toHaveLength(2);
    fake.failBuilders.add('addWall');
    const r = await receive(fake, speckleServer(), { url: MODEL_URL });
    expect(fake.entities.filter((e) => e.type === 'IfcWall' && e.expressId >= 1000).map((e) => [e.globalId, e.expressId])).toEqual(before);
    const kept = refusalsOf(r).find((x) => x.reason === 'write-failed-kept-previous');
    expect([kept?.speckleType, kept?.count]).toEqual(['RevitWall', 2]);
    expect(kept?.message).toMatch(/the element from the earlier receive was kept/);
    expect(refusalsOf(r).some((x) => x.reason === 'write-failed')).toBe(false);
  });

  it('a first receive into an empty slot writes and reports write-failed, not kept-previous', async () => {
    const fake = oneStoreyBim();
    fake.failBuilders.add('addBeam');
    const r = await receive(fake, speckleServer(), { url: MODEL_URL });
    expect(summary(refusalsOf(r)).filter((s) => s.includes('write-failed'))).toEqual(['RevitBeam write-failed 1']);
  });

  it('needs model.delete only to replace an earlier receive (#5925 review)', async () => {
    const fake = oneStoreyBim();
    const noDelete = ['model.read', 'model.create', 'model.mutate:Speckle_Source', 'model.mutate:Speckle_TypeParameters', 'model.mutate:Speckle_InstanceParameters'];
    const first = await receive(fake, speckleServer(), { url: MODEL_URL }, [CORPUS_HOST], noDelete);
    expect(first.reports.find((x) => x.nodeId === 'rx')?.laneErrors).toBe(0);
    expect(fake.created).toHaveLength(6);
    // One NEW element ahead of the replacements: the refusal must come before it is written.
    const beforeSecond = fake.created.length;
    const extra = speckleServer({ extraWallFirst: true });
    const second = await receive(fake, extra, { url: MODEL_URL }, [CORPUS_HOST], noDelete);
    expect(laneError(second)).toMatch(/model\.delete/);
    expect(fake.created.length).toBe(beforeSecond);
    const third = await receive(fake, speckleServer(), { url: MODEL_URL }, [CORPUS_HOST], [...noDelete, 'model.delete']);
    expect(third.reports.find((x) => x.nodeId === 'rx')?.laneErrors).toBe(0);
    expect(fake.entities.filter((e) => e.expressId >= 1000).map((e) => e.globalId)).toEqual(['300101', '300102', '300201', '300301', '300401', '300501'].map(guidOf));
  });

  it('scopes identity by server origin as well as project (#5925 review)', async () => {
    const a = oneStoreyBim();
    await receive(a, speckleServer(), { url: MODEL_URL });
    const b = oneStoreyBim();
    await receive(b, speckleServer(), { url: `https://OTHER.example.com:443/projects/${CORPUS_PROJECT}/models/m1` }, ['other.example.com']);
    const ids = (f: FakeHost) => f.created.map((c) => c.params.GlobalId);
    expect(ids(b)).toEqual(['300101', '300102', '300201', '300301', '300401', '300501'].map((id) => guidOn('other.example.com', id)));
    expect(ids(b).some((g) => ids(a).includes(g))).toBe(false);
  });
});
