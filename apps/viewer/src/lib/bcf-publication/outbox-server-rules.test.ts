/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The topic type preselected when a server's fixed list lacks the draft's type.

import test from 'node:test';
import assert from 'node:assert/strict';
import { closestTopicType, preselectTopicTypes } from './outbox-server-rules';
import type { PreflightReport } from './outbox-preflight';

const BUILDAGIL_TYPES = ['Task', 'Model Issue', 'Documentation Log', 'Incident Log', 'Deficiency Log', 'Topic', 'Information', 'Decision'];

test('clash and issue drafts preselect an issue type such as Model Issue; others fall back sensibly', () => {
  assert.equal(closestTopicType('Clash', BUILDAGIL_TYPES), 'Model Issue');
  assert.equal(closestTopicType('Issue', BUILDAGIL_TYPES), 'Model Issue');
  assert.equal(closestTopicType('issue', ['Request', 'Issue']), 'Issue', 'a case-only difference wins');
  assert.equal(closestTopicType('Clash', ['Request', 'Clash detection', 'Issue']), 'Clash detection', 'a type naming the draft type');
  assert.equal(closestTopicType('Clash', ['Request', 'Remark']), 'Request', 'no issue type: the first');
  assert.equal(closestTopicType('Remark', BUILDAGIL_TYPES), 'Task');
  assert.equal(closestTopicType('Clash', []), undefined);
});

test('preselection keeps a valid earlier choice and fills only unknown draft types', () => {
  const report = { ok: false, at: '', warnings: [], extensions: {}, issues: [
    { kind: 'vocabulary', field: 'topic_type', value: 'Clash', allowed: BUILDAGIL_TYPES },
    { kind: 'vocabulary', field: 'topic_type', value: 'Issue', allowed: BUILDAGIL_TYPES },
    { kind: 'vocabulary', field: 'priority', value: 'Low', allowed: ['High'] },
  ] } satisfies PreflightReport;
  assert.deepEqual(preselectTopicTypes(report, { Clash: 'Information', Remark: 'Topic' }),
    { Clash: 'Information', Issue: 'Model Issue', Remark: 'Topic' });
  assert.deepEqual(preselectTopicTypes(report, { Clash: 'Gone' }), { Clash: 'Model Issue', Issue: 'Model Issue' });
});
