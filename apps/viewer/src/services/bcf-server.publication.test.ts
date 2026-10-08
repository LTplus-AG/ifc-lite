/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { IfcParser } from '@ifc-lite/parser';
import { BcfApiError, fetchProjectAsBCF, type BcfViewpointDto } from '@ifc-lite/bcf-api';
import { readBCF, writeBCF } from '@ifc-lite/bcf';
import { startLocalBcfServer, LOCAL_BCF_PROJECT, LOCAL_BCF_TOKEN, LOCAL_BCF_USER } from '@/test/bcf-http-server';
import { clearBcfServerConfig, createConnectedClient, loadBcfServerConfig,
  pullBcfServerProject, signInWithToken } from './bcf-server';

async function connection(t: TestContext) {
  clearBcfServerConfig();
  const server = await startLocalBcfServer();
  t.after(async () => { clearBcfServerConfig(); await server.close(); });
  await signInWithToken(server.baseUrl, LOCAL_BCF_TOKEN);
  return { ...server, client: await createConnectedClient() };
}

// #6836: every request uses the actual loopback HTTP peer, native transport and mappings.
test('connected create/update/comment/viewpoint/pull/archive retains real IFC identities and human review', async t => {
  const { client, state } = await connection(t);
  const bytes = await readFile(new URL('../../public/samples/building-architecture.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer);
  const walls = Array.from(store.entities.expressId).filter(id => store.entities.getTypeName(id) === 'IfcWall');
  assert.equal(walls.length, 4);
  const ifcGuid = store.entities.getGlobalId(walls[0]);
  assert.equal(ifcGuid.length, 22);
  const created = await client.createTopic(LOCAL_BCF_PROJECT, {
    title: 'Review native wall', topic_type: 'Clash', topic_status: 'Open', priority: 'High',
    description: 'Historical controlled coordination example; not a measured clash.',
  });
  assert.match(created.guid, /^[0-9a-f-]{36}$/);
  const viewpoint: BcfViewpointDto = { guid: randomUUID(),
    perspective_camera: { camera_view_point: { x: 8, y: 5, z: 4 }, camera_direction: { x: -1, y: 0, z: 0 },
      camera_up_vector: { x: 0, y: 0, z: 1 }, field_of_view: 60 },
    components: { selection: [{ ifc_guid: ifcGuid, originating_system: 'SketchUp', authoring_tool_id: String(walls[0]) }],
      visibility: { default_visibility: true, exceptions: [] } },
    clipping_planes: [{ location: { x: 2, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }] };
  await client.createViewpoint(LOCAL_BCF_PROJECT, created.guid, viewpoint);
  const comment = await client.createComment(LOCAL_BCF_PROJECT, created.guid,
    { comment: 'Human review remains attached.', viewpoint_guid: viewpoint.guid });
  const updated = await client.updateTopic(LOCAL_BCF_PROJECT, created.guid,
    { title: 'Reviewed native wall', topic_status: 'Resolved', topic_type: 'Clash', priority: 'Normal' });
  assert.equal(updated.guid, created.guid);
  assert.equal(state.acceptedWrites, 4);
  assert.equal(state.topics.size, 1);
  const pulled = await pullBcfServerProject(LOCAL_BCF_PROJECT, 'Local coordination');
  assert.deepEqual(pulled.warnings, []);
  const roundtrip = await readBCF(await (await writeBCF(pulled.project)).arrayBuffer());
  assert.equal(roundtrip.topics.size, 1);
  const topic = roundtrip.topics.get(created.guid);
  assert.ok(topic);
  assert.equal(topic.title, 'Reviewed native wall');
  assert.equal(topic.topicStatus, 'Resolved');
  assert.equal(topic.creationAuthor, LOCAL_BCF_USER);
  assert.equal(topic.comments[0].guid, comment.guid);
  assert.equal(topic.comments[0].comment, 'Human review remains attached.');
  assert.equal(topic.comments[0].viewpointGuid, viewpoint.guid);
  const restored = topic.viewpoints[0];
  assert.equal(restored.guid, viewpoint.guid);
  assert.equal(restored.components?.selection?.[0].ifcGuid, ifcGuid);
  assert.equal(store.entities.getExpressIdByGlobalId(restored.components?.selection?.[0].ifcGuid ?? ''), walls[0]);
  assert.deepEqual(restored.perspectiveCamera?.cameraViewPoint, { x: 8, y: 5, z: 4 });
  assert.deepEqual(restored.clippingPlanes, [{ location: { x: 2, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }]);
  assert.equal(loadBcfServerConfig()?.projectId, LOCAL_BCF_PROJECT);
});

test('server vocabulary and revoked project authorization reject writes without effects', async t => {
  const { client, state } = await connection(t);
  const extensions = await client.getExtensions(LOCAL_BCF_PROJECT);
  assert.deepEqual(extensions.topic_status, ['Open', 'Resolved']);
  await assert.rejects(client.createTopic(LOCAL_BCF_PROJECT, { title: 'Bad status', topic_status: 'Invented' }),
    (error: unknown) => error instanceof BcfApiError && error.status === 400);
  assert.equal(state.acceptedWrites, 0);
  state.writesAllowed = false;
  assert.deepEqual((await client.getProject(LOCAL_BCF_PROJECT)).authorization?.project_actions, []);
  await assert.rejects(client.createTopic(LOCAL_BCF_PROJECT, { title: 'Permission lost', topic_status: 'Open' }),
    (error: unknown) => error instanceof BcfApiError && error.status === 403);
  assert.equal(state.topics.size, 0);
  assert.equal(state.acceptedWrites, 0);
  state.tokenValid = false;
  await assert.rejects(client.getProjects(), (error: unknown) => error instanceof BcfApiError && error.isAuthError);
});

test('lost create response leaves a committed topic and native client never retries the write', async t => {
  const { client, state } = await connection(t);
  state.loseNextWriteResponse = true;
  await assert.rejects(client.createTopic(LOCAL_BCF_PROJECT, { title: 'Uncertain result', topic_status: 'Open' }));
  assert.equal(state.acceptedWrites, 1);
  assert.equal(state.receivedWrites, 1, 'a network failure must not cause automatic POST replay');
  const observed = await client.getTopics(LOCAL_BCF_PROJECT);
  assert.equal(observed.length, 1, 'a rejected request does not establish that the server did not commit');
  // The native create DTO has no client correlation identifier: this observation
  // is insufficient to prove ownership in a shared project. Outbox must stay blocked.
  assert.equal(observed[0].title, 'Uncertain result');
  assert.equal(state.receivedWrites, 1, 'read-only reconciliation adds no remote effect');
});

test('lost comment/update/viewpoint responses preserve each effect for explicit reconciliation', async t => {
  const { client, state } = await connection(t);
  const topic = await client.createTopic(LOCAL_BCF_PROJECT, { title: 'Initial', topic_status: 'Open' });
  state.loseNextWriteResponse = true;
  await assert.rejects(client.createComment(LOCAL_BCF_PROJECT, topic.guid, { comment: 'Uncertain comment' }));
  assert.equal((await client.getComments(LOCAL_BCF_PROJECT, topic.guid)).length, 1);
  state.loseNextWriteResponse = true;
  await assert.rejects(client.updateTopic(LOCAL_BCF_PROJECT, topic.guid, { title: 'Remote edit', topic_status: 'Resolved' }));
  assert.equal((await client.getTopic(LOCAL_BCF_PROJECT, topic.guid)).topic_status, 'Resolved');
  const guid = randomUUID();
  state.loseNextWriteResponse = true;
  await assert.rejects(client.createViewpoint(LOCAL_BCF_PROJECT, topic.guid, { guid,
    orthogonal_camera: { camera_view_point: { x: 0, y: 0, z: 4 }, camera_direction: { x: 0, y: 0, z: -1 },
      camera_up_vector: { x: 0, y: 1, z: 0 }, view_to_world_scale: 10 } }));
  assert.equal((await client.getViewpoint(LOCAL_BCF_PROJECT, topic.guid, guid)).guid, guid);
  assert.equal(state.acceptedWrites, 4);
  assert.equal(state.receivedWrites, 4);
  const pulled = await fetchProjectAsBCF(client, LOCAL_BCF_PROJECT, { includeSnapshots: false, pageSize: 1 });
  assert.deepEqual(pulled.warnings, []);
  assert.equal(pulled.project.topics.get(topic.guid)?.comments[0].comment, 'Uncertain comment');
});

test('native create is non-idempotent; equal titles do not establish duplicate ownership', async t => {
  const { client, state } = await connection(t);
  const first = await client.createTopic(LOCAL_BCF_PROJECT, { title: 'Same coordination title' });
  const second = await client.createTopic(LOCAL_BCF_PROJECT, { title: 'Same coordination title' });
  assert.notEqual(first.guid, second.guid);
  assert.equal(state.topics.size, 2, 'outbox must never substitute title matching for exact effect identity');
});
