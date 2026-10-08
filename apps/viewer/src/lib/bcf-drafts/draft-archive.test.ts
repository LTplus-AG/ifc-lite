/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6896 (P11): draft batches survive real .bcfzip bytes with their mapping,
// stay readable as plain BCF, and plain archives import without a mapping.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBCFProject, createBCFTopic, readBCF, writeBCF } from '@ifc-lite/bcf';
import { strFromU8, unzipSync } from 'fflate';
import { resolveManualClashGroups } from '../clash/manual-groups';
import { groupOf, proxyWallRun, sampleElements, PROXY_WALL_RULE } from '@/test/bcf-draft-fixture';
import { draftBatchFromGroups } from './draft-create';
import { addDraftComment } from './draft-edit';
import { exportDraftArchive, importDraftArchive } from './draft-archive';
import { DRAFT_FOOTER_MARKER } from './draft-footer';

async function batchWithComment() {
  const { proxies } = await sampleElements();
  const clashes = await proxyWallRun([[0, 1], [1], [2]]);
  const groups = [groupOf('g1', 'Riser', clashes, [proxies[0].key, proxies[1].key]), groupOf('g2', 'East', clashes, [proxies[2].key])];
  const batch = await draftBatchFromGroups('Round 1', 'ws', resolveManualClashGroups(groups, clashes),
    { clashes, rules: [PROXY_WALL_RULE.id], worldOffset: { x: 100, y: 0, z: -5 } });
  const commented = addDraftComment(batch, batch.topics[0].guid, 'Check sleeve sizes on site.');
  assert.ok(commented.ok);
  return commented.batch;
}

test('export -> bytes -> import restores the batch, topic GUIDs, members, viewpoint and comments', async () => {
  const batch = await batchWithComment();
  const bytes = await (await exportDraftArchive(batch, 'coordinator@example.test')).arrayBuffer();
  const files = unzipSync(new Uint8Array(bytes));
  assert.ok(files['bcf.version'], 'a real BCF archive');
  const markup = strFromU8(files[`${batch.topics[0].guid}/markup.bcf`]);
  assert.match(markup, /ifc-lite BCF draft mapping v1/);
  const imported = await importDraftArchive(bytes);
  assert.equal(imported.unmapped, 0);
  assert.equal(imported.damaged, 0);
  assert.equal(imported.batches.length, 1);
  const [restored] = imported.batches;
  assert.equal(restored.id, batch.id);
  assert.equal(restored.name, batch.name);
  assert.deepEqual(restored.source, batch.source, 'run digest, rules and world offset survive');
  assert.deepEqual(restored.topics.map(topic => topic.guid), batch.topics.map(topic => topic.guid));
  assert.deepEqual(restored.topics.map(topic => topic.members), batch.topics.map(topic => topic.members));
  assert.deepEqual(restored.topics.map(topic => topic.origin), batch.topics.map(topic => topic.origin));
  assert.deepEqual(restored.topics.map(topic => topic.description), batch.topics.map(topic => topic.description), 'footer is stripped on import');
  assert.deepEqual(restored.topics[0].comments, batch.topics[0].comments);
  assert.deepEqual(restored.topics[0].viewpoint?.components?.selection, batch.topics[0].viewpoint?.components?.selection);
  assert.deepEqual(restored.topics[0].viewpoint?.perspectiveCamera?.cameraViewPoint, batch.topics[0].viewpoint?.perspectiveCamera?.cameraViewPoint);
});

test('the exported archive is plain BCF to any reader: titles, statuses and a readable description', async () => {
  const batch = await batchWithComment();
  const project = await readBCF(await (await exportDraftArchive(batch, 'coordinator@example.test')).arrayBuffer());
  const topic = project.topics.get(batch.topics[0].guid);
  assert.ok(topic);
  assert.equal(topic.title, 'Riser');
  assert.equal(topic.topicType, 'Clash');
  assert.equal(topic.creationAuthor, 'coordinator@example.test');
  assert.ok(topic.description?.startsWith(batch.topics[0].description), 'human text first, generated mapping below');
  assert.equal(topic.comments[0].comment, 'Check sleeve sizes on site.');
});

test('a plain BCF archive imports as an unmapped batch and an edited footer is reported, not trusted', async () => {
  const plain = createBCFProject({ name: 'Other tool export' });
  const other = createBCFTopic({ title: 'Door swing conflict', author: 'someone@example.test', description: 'From another tool' });
  plain.topics.set(other.guid, other);
  const batch = await batchWithComment();
  const exported = await readBCF(await (await exportDraftArchive(batch, 'a@example.test')).arrayBuffer());
  const tampered = exported.topics.get(batch.topics[1].guid);
  assert.ok(tampered?.description);
  tampered.description = tampered.description.replace(/\nm: [^\n]+/, '');
  plain.topics.set(tampered.guid, tampered);
  const imported = await importDraftArchive(await (await writeBCF(plain)).arrayBuffer());
  assert.equal(imported.unmapped, 1);
  assert.equal(imported.damaged, 1);
  assert.equal(imported.batches.length, 1);
  const topics = imported.batches[0].topics;
  assert.deepEqual(topics.map(topic => topic.members.length), [0, 0], 'no half-trusted membership');
  assert.ok(topics.every(topic => topic.origin.kind === 'archive'));
  assert.ok(topics.every(topic => !topic.description.includes(DRAFT_FOOTER_MARKER)));
});
