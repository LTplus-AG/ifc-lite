/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { BCFProject, BCFTopic } from '@ifc-lite/bcf';
import { bcfFindings } from './bcf';

const topic = (guid: string, extra: Partial<BCFTopic> = {}): BCFTopic => ({
  guid, title: `Topic ${guid}`, creationDate: '2026-01-01T00:00:00Z', creationAuthor: 'a@example.com', comments: [], viewpoints: [], ...extra,
}) as BCFTopic;
const project = (...topics: BCFTopic[]) => ({ version: '2.1', name: 'Coordination', topics: new Map(topics.map(t => [t.guid, t])) }) as BCFProject;

test('a topic names the GlobalIds its viewpoints select or colour, once each, and no model', () => {
  const out = bcfFindings(project(topic('T1', { topicStatus: 'Open', viewpoints: [{ guid: 'V1', components: {
    selection: [{ ifcGuid: 'W1' }, { ifcGuid: 'W2' }], coloring: [{ color: 'ff0000', components: [{ ifcGuid: 'W2' }, { ifcGuid: 'W3' }] }] } }] as BCFTopic['viewpoints'] })));
  const [finding] = out.findings;
  assert.deepEqual(finding.elements.map(e => [e.globalId, e.modelId, e.modelName]).sort(), [['W1', null, null], ['W2', null, null], ['W3', null, null]]);
  assert.equal(finding.nativeStatus, 'Open');
  assert.equal(finding.lifecycle, 'record');
});

test('no project or an empty project contributes nothing', () => {
  assert.deepEqual(bcfFindings(null), { runs: [], findings: [] });
  assert.deepEqual(bcfFindings(project()), { runs: [], findings: [] });
});
