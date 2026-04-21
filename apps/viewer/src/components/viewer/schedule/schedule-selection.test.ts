/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ScheduleExtraction, ScheduleTaskInfo } from '@ifc-lite/parser';
import {
  collectProductLocalIdsForTasks,
  findTaskForProductGlobalId,
  findTaskForProductGlobalIdWithLocal,
} from './schedule-selection.js';

function task(over: Partial<ScheduleTaskInfo>): ScheduleTaskInfo {
  return {
    expressId: 0,
    globalId: 'T',
    name: 'Task',
    isMilestone: false,
    childGlobalIds: [],
    productExpressIds: [],
    productGlobalIds: [],
    controllingScheduleGlobalIds: [],
    ...over,
  };
}

function schedule(tasks: ScheduleTaskInfo[]): ScheduleExtraction {
  return { hasSchedule: true, workSchedules: [], sequences: [], tasks };
}

describe('collectProductLocalIdsForTasks', () => {
  it('returns empty set for null data', () => {
    const out = collectProductLocalIdsForTasks(null, ['x']);
    assert.equal(out.size, 0);
  });

  it('returns the task own products for a leaf selection', () => {
    const data = schedule([task({ globalId: 'leaf', productExpressIds: [1, 2, 3] })]);
    const out = collectProductLocalIdsForTasks(data, ['leaf']);
    assert.deepEqual(Array.from(out).sort((a, b) => a - b), [1, 2, 3]);
  });

  it('unions descendant products when a parent is selected', () => {
    const data = schedule([
      task({ globalId: 'parent', childGlobalIds: ['childA', 'childB'], productExpressIds: [10] }),
      task({ globalId: 'childA', productExpressIds: [20, 21] }),
      task({ globalId: 'childB', productExpressIds: [30], childGlobalIds: ['leaf'] }),
      task({ globalId: 'leaf', productExpressIds: [40] }),
    ]);
    const out = collectProductLocalIdsForTasks(data, ['parent']);
    assert.deepEqual(Array.from(out).sort((a, b) => a - b), [10, 20, 21, 30, 40]);
  });

  it('is idempotent when multiple selected tasks overlap via children', () => {
    const data = schedule([
      task({ globalId: 'A', childGlobalIds: ['shared'], productExpressIds: [1] }),
      task({ globalId: 'B', childGlobalIds: ['shared'], productExpressIds: [2] }),
      task({ globalId: 'shared', productExpressIds: [99] }),
    ]);
    const out = collectProductLocalIdsForTasks(data, ['A', 'B']);
    assert.deepEqual(Array.from(out).sort((a, b) => a - b), [1, 2, 99]);
  });

  it('defends against cyclic childGlobalIds', () => {
    const data = schedule([
      task({ globalId: 'A', childGlobalIds: ['B'], productExpressIds: [1] }),
      task({ globalId: 'B', childGlobalIds: ['A'], productExpressIds: [2] }),
    ]);
    const out = collectProductLocalIdsForTasks(data, ['A']);
    // Cycle must not hang and must visit each task exactly once.
    assert.deepEqual(Array.from(out).sort((a, b) => a - b), [1, 2]);
  });

  it('skips unknown globalIds without throwing', () => {
    const data = schedule([task({ globalId: 'A', productExpressIds: [1] })]);
    const out = collectProductLocalIdsForTasks(data, ['A', 'does-not-exist']);
    assert.deepEqual(Array.from(out), [1]);
  });
});

describe('findTaskForProductGlobalId', () => {
  const data = schedule([
    task({ globalId: 'root', childGlobalIds: ['parent'] }),
    task({
      globalId: 'parent',
      parentGlobalId: 'root',
      childGlobalIds: ['hit', 'other'],
    }),
    task({
      globalId: 'hit',
      parentGlobalId: 'parent',
      productExpressIds: [42],
      productGlobalIds: ['42', '43'],
    }),
    task({
      globalId: 'other',
      parentGlobalId: 'parent',
      productExpressIds: [99],
      productGlobalIds: ['99'],
    }),
  ]);

  it('returns the owning task and its ancestor chain (fast path via productGlobalIds)', () => {
    const result = findTaskForProductGlobalId(data, 42);
    assert.ok(result);
    assert.equal(result.taskGlobalId, 'hit');
    assert.deepEqual(result.ancestorGlobalIds, ['root', 'parent']);
  });

  it('returns null when no task owns the product', () => {
    const result = findTaskForProductGlobalId(data, 777);
    assert.equal(result, null);
  });

  it('returns null for null schedule data', () => {
    const result = findTaskForProductGlobalId(null, 42);
    assert.equal(result, null);
  });
});

describe('findTaskForProductGlobalIdWithLocal', () => {
  // Extracted (non-generated) schedules have empty productGlobalIds — we
  // must be able to translate a global → local and still find the owner.
  const data = schedule([
    task({ globalId: 'only', productExpressIds: [42], productGlobalIds: [] }),
  ]);

  it('falls back to the local-id scan when productGlobalIds is empty', () => {
    const result = findTaskForProductGlobalIdWithLocal(
      data,
      1042, // global
      (g) => g - 1000, // idOffset = 1000
    );
    assert.ok(result);
    assert.equal(result.taskGlobalId, 'only');
    assert.deepEqual(result.ancestorGlobalIds, []);
  });

  it('returns null when the local translator yields nothing or the scan misses', () => {
    const result = findTaskForProductGlobalIdWithLocal(
      data,
      9999,
      () => undefined,
    );
    assert.equal(result, null);
  });
});
