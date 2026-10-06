/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readBCF, createBCFProject, createBCFTopic, type BCFProject } from '@ifc-lite/bcf';
import { render, click, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { captureEvidence, evidenceIsCurrent } from '../evidence';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

/** A BIMcollab Zoom export over AC20-FZK-Haus, committed with the BCF package. */
async function bimcollabProject(): Promise<BCFProject> {
  const bytes = readFileSync(new URL('../../../../../../packages/bcf/test-data/AC20-FZK-Haus_BIMcollabZoom.bcf', import.meta.url));
  return readBCF(new Uint8Array(bytes));
}

const payloadOf = (snapshot: ReturnType<typeof captureEvidence>) => JSON.parse(snapshot.payload);

// #6833: topics from a real BCF archive become one row each, with native status counts,
// referenced GlobalIds from viewpoint selections, and no snapshot or image content.
test('BCF evidence lists the loaded project topics without snapshots (#6833)', async () => {
  useViewerStore.setState(fixtureModels(fixtureModel('haus')));
  assert.equal(payloadOf(captureEvidence('bcf')).sourceAvailability, 'unavailable', 'no BCF project loaded');

  const project = await bimcollabProject();
  const topics = [...project.topics.values()];
  assert.ok(topics.length > 0, 'the archive has topics');
  assert.ok(topics.some(topic => topic.viewpoints.some(vp => vp.snapshot || vp.snapshotData)), 'the archive carries snapshots');
  useViewerStore.getState().setBcfProject(project);

  const snapshot = captureEvidence('bcf');
  const payload = payloadOf(snapshot);
  assert.equal(payload.sourceAvailability, 'available');
  assert.equal(snapshot.totalRows, topics.length);
  const summary = payload.evidence.summary;
  assert.equal(summary.topicCount, topics.length);
  const statuses = topics.reduce<Record<string, number>>((acc, topic) => {
    const status = topic.topicStatus || summary.noStatusKey;
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(summary.topicsByStatus, statuses);
  const first = topics[0];
  const row = payload.evidence.rows[0].data;
  assert.deepEqual([row.kind, row.guid, row.title, row.status, row.commentCount, row.viewpointCount],
    ['bcfTopic', first.guid, first.title, first.topicStatus ?? null, first.comments.length, first.viewpoints.length]);
  const selectedOf = (index: number) => new Set(topics[index].viewpoints.flatMap(vp => (vp.components?.selection ?? []).flatMap(c => (c.ifcGuid ? [c.ifcGuid] : []))));
  const withSelection = topics.findIndex((_, index) => selectedOf(index).size > 0);
  assert.ok(withSelection >= 0, 'a topic viewpoint selects elements');
  const selected = selectedOf(withSelection);
  const selectedRow = payload.evidence.rows[withSelection].data;
  assert.equal(selectedRow.ifcGuidCount, selected.size);
  assert.ok(selectedRow.ifcGuids.length === Math.min(10, selected.size) && selectedRow.ifcGuids.every((guid: string) => selected.has(guid)));
  assert.doesNotMatch(snapshot.payload, /data:image|snapshot\.png|"snapshot"/i);
  for (const topic of topics) for (const comment of topic.comments) {
    if (comment.comment.length > 20) assert.equal(snapshot.payload.includes(comment.comment), false, 'comment bodies are not evidence');
  }

  assert.equal(evidenceIsCurrent(snapshot), true);
  useViewerStore.getState().updateTopic(first.guid, { topicStatus: 'Closed' });
  assert.equal(evidenceIsCurrent(snapshot), false, 'a topic edit replaces the project identity');
});

// #6833: exact totals beyond the row sample, and an empty project is available with zero rows.
test('BCF evidence keeps topic totals beyond the sample and reports an empty project as available (#6833)', () => {
  useViewerStore.setState(fixtureModels(fixtureModel('haus')));
  useViewerStore.getState().setBcfProject(createBCFProject({ name: 'Coordination' }));
  const empty = captureEvidence('bcf');
  assert.equal(payloadOf(empty).sourceAvailability, 'available');
  assert.equal(empty.totalRows, 0);

  for (let i = 0; i < 120; i++) {
    useViewerStore.getState().addTopic(createBCFTopic({ title: `Issue ${i}`, author: 'reviewer@example.com', topicStatus: i % 3 === 0 ? 'Closed' : 'Open', priority: 'High' }));
  }
  const many = captureEvidence('bcf');
  const payload = payloadOf(many);
  assert.equal(many.totalRows, 120);
  assert.equal(payload.includedRows, 100);
  assert.equal(payload.sampled, true);
  assert.deepEqual(payload.evidence.summary.topicsByStatus, { Closed: 40, Open: 80 });
  assert.equal(payload.evidence.summary.projectName, 'Coordination');
});

// #6833: the BCF panel (AnalysisPanel header) attaches the loaded project.
test('the BCF panel header attaches the BCF topics (#6833)', async () => {
  useViewerStore.setState(fixtureModels(fixtureModel('haus')));
  useViewerStore.getState().setBcfProject(await bimcollabProject());
  const panel = render(renderPanelBody('bcf', () => undefined));
  const discuss = panel.querySelector('button[aria-label="Discuss with AI"]');
  assert.ok(discuss);
  click(discuss);
  assert.equal(useAssistant.getState().snapshot?.source, 'bcf');
  assert.equal(useAssistant.getState().snapshot?.totalRows, useViewerStore.getState().bcfProject?.topics.size);
});
