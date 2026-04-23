/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  parseIsoDate,
  msToIsoDuration,
  addIsoDurationToEpoch,
  toIsoUtc,
  reconcileTaskTime,
  cloneExtraction,
  resolveSingleModelId,
  resolveIdOffset,
} from './schedule-edit-helpers.js';

describe('schedule-edit-helpers — ISO date parsing', () => {
  it('normalises tz-less inputs to UTC', () => {
    // 2024-05-01T08:00:00 at UTC == 1714550400000 ms.
    const a = parseIsoDate('2024-05-01T08:00:00');
    const b = parseIsoDate('2024-05-01T08:00:00Z');
    assert.strictEqual(a, b);
  });

  it('returns undefined for missing / unparseable input', () => {
    assert.strictEqual(parseIsoDate(undefined), undefined);
    assert.strictEqual(parseIsoDate(''), undefined);
    assert.strictEqual(parseIsoDate('not-a-date'), undefined);
  });

  it('round-trips through toIsoUtc', () => {
    const ms = parseIsoDate('2024-05-01T08:00:00Z')!;
    assert.strictEqual(toIsoUtc(ms), '2024-05-01T08:00:00');
  });
});

describe('schedule-edit-helpers — ISO duration round-trip', () => {
  it('msToIsoDuration emits PT0S for zero', () => {
    assert.strictEqual(msToIsoDuration(0), 'PT0S');
  });

  it('emits days + time components', () => {
    const twoDaysFourHours = 2 * 86_400_000 + 4 * 3_600_000;
    assert.strictEqual(msToIsoDuration(twoDaysFourHours), 'P2DT4H');
  });

  it('addIsoDurationToEpoch inverts msToIsoDuration', () => {
    const start = parseIsoDate('2024-05-01T08:00:00Z')!;
    const iso = msToIsoDuration(5 * 86_400_000);
    const end = addIsoDurationToEpoch(start, iso);
    assert.strictEqual(end! - start, 5 * 86_400_000);
  });

  it('addIsoDurationToEpoch returns undefined for malformed input', () => {
    assert.strictEqual(addIsoDurationToEpoch(0, 'NOT-A-DURATION'), undefined);
  });
});

describe('schedule-edit-helpers — reconcileTaskTime', () => {
  it('derives duration when start + finish supplied', () => {
    const result = reconcileTaskTime({
      scheduleStart: '2024-05-01T08:00:00Z',
      scheduleFinish: '2024-05-03T08:00:00Z',
    });
    assert.strictEqual(result?.scheduleDuration, 'P2D');
  });

  it('derives finish when start + duration supplied (no finish)', () => {
    const result = reconcileTaskTime({
      scheduleStart: '2024-05-01T08:00:00Z',
      scheduleDuration: 'P3D',
    });
    assert.strictEqual(result?.scheduleFinish, '2024-05-04T08:00:00');
  });

  it('rejects finish < start', () => {
    const result = reconcileTaskTime({
      scheduleStart: '2024-05-03T08:00:00Z',
      scheduleFinish: '2024-05-01T08:00:00Z',
    });
    assert.strictEqual(result, null);
  });
});

describe('schedule-edit-helpers — cloneExtraction', () => {
  it('does not share mutable refs with source', () => {
    const src = {
      hasSchedule: true,
      workSchedules: [],
      sequences: [],
      tasks: [{
        expressId: 1,
        globalId: 'a',
        name: 'A',
        isMilestone: false,
        childGlobalIds: ['child1'],
        productExpressIds: [10, 20],
        productGlobalIds: ['g1'],
        controllingScheduleGlobalIds: [],
      }],
    };
    const clone = cloneExtraction(src as never);
    clone.tasks[0].name = 'B';
    clone.tasks[0].productExpressIds.push(99);
    assert.strictEqual(src.tasks[0].name, 'A');
    assert.deepStrictEqual(src.tasks[0].productExpressIds, [10, 20]);
  });
});

describe('schedule-edit-helpers — federation helpers', () => {
  it('resolveSingleModelId returns null for 0 or 2+ models', () => {
    assert.strictEqual(resolveSingleModelId({}), null);
    assert.strictEqual(resolveSingleModelId({ models: new Map() }), null);
    const two = new Map<string, unknown>([['a', {}], ['b', {}]]);
    assert.strictEqual(resolveSingleModelId({ models: two }), null);
  });

  it('resolveSingleModelId returns the only key when size=1', () => {
    const one = new Map<string, unknown>([['only', {}]]);
    assert.strictEqual(resolveSingleModelId({ models: one }), 'only');
  });

  it('resolveIdOffset returns 0 for null sourceModelId', () => {
    assert.strictEqual(resolveIdOffset({}, null), 0);
  });

  it('resolveIdOffset reads idOffset from the named model', () => {
    const models = new Map([['m1', { idOffset: 1000 }]]);
    assert.strictEqual(resolveIdOffset({ models }, 'm1'), 1000);
  });
});
