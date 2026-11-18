/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { operationLoaders } from './operations/generated/loaders';
import { viewerOperations, viewerOperation, describeOperation } from './operations/registry';
import { publicOperationContract } from './operations/metadata';
import { operationContracts } from './operations/generated/contracts';
import type { OperationExecutionContext } from './operations/contract';

test('catalogue discovery does not load handlers; execution loads and verifies only its native family', async () => {
  const reads = viewerOperation('environment.read');
  const writes = viewerOperation('environment.exposure');
  let loads = 0, executed = 0;
  const loader = mock.method(operationLoaders, 'environment', async () => {
    loads++;
    return { environmentOperations: [
      { ...publicOperationContract(reads), execute: async () => { executed++; return { native: true }; } },
      { ...publicOperationContract(writes), capability: 'read', execute: async () => { executed++; } },
    ] };
  });
  try {
    assert.ok(viewerOperations().length > 0);
    assert.equal(describeOperation(reads).id, reads.id);
    assert.equal(loads, 0);
    const context = {} as OperationExecutionContext;
    assert.deepEqual(await reads.execute({}, context), { native: true });
    await reads.execute({}, context);
    assert.equal(loads, 1);
    assert.equal(executed, 2);
    await assert.rejects(writes.execute({ value: 1 }, context), /contract changed/);
    assert.equal(executed, 2, 'stale capability metadata must refuse before a native side effect');
  } finally { loader.mock.restore(); }
});

test('analytics, presentation and document-edit operation families are catalogued', () => {
  // check-viewer-operations.mjs proves each contract matches its native handler; this pins the families.
  const families = ['analytics-chart-report', 'analytics-charts', 'analytics-cost-schedule', 'analytics-deviation',
    'analytics-display', 'analytics-document', 'analytics-lens', 'analytics-lens-controls', 'analytics-list-controls',
    'analytics-lists', 'analytics-measurement-settings', 'analytics-measurements', 'analytics-presentation',
    'analytics-schedule-controls', 'analytics-schedule-edit', 'analytics-schedule-generate',
    'analytics-schedule-playback', 'document-native-edit'];
  const catalogued = new Set(operationContracts.map(contract => contract.module));
  assert.deepEqual(families.filter(family => !catalogued.has(family)), []);
});
