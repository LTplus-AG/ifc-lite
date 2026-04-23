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
} from './schedule-edit-helpers.js';

describe('schedule-edit-helpers — ISO 8601 date+duration round-trip', () => {
  it('parseIsoDate normalises tz-less inputs to UTC', () => {
    // Regression: before this normalization, opening the same IFC on
    // machines in different timezones produced different epoch values,
    // shifting the Gantt and breaking STEP round-trip equality.
    assert.strictEqual(
      parseIsoDate('2024-05-01T08:00:00'),
      parseIsoDate('2024-05-01T08:00:00Z'),
    );
    assert.strictEqual(parseIsoDate('not-a-date'), undefined);
  });

  it('msToIsoDuration ↔ addIsoDurationToEpoch invert each other', () => {
    // Property test — the two halves of the duration pipeline must be
    // strict inverses, otherwise a task's finish = start + duration
    // computation drifts on every round-trip.
    const start = parseIsoDate('2024-05-01T08:00:00Z')!;
    const deltaMs = 5 * 86_400_000 + 4 * 3_600_000;
    const iso = msToIsoDuration(deltaMs);
    assert.strictEqual(iso, 'P5DT4H');
    assert.strictEqual(addIsoDurationToEpoch(start, iso)! - start, deltaMs);
    assert.strictEqual(addIsoDurationToEpoch(0, 'NOT-A-DURATION'), undefined);
  });

  it('toIsoUtc round-trips with parseIsoDate', () => {
    const ms = parseIsoDate('2024-05-01T08:00:00Z')!;
    assert.strictEqual(toIsoUtc(ms), '2024-05-01T08:00:00');
  });
});

describe('schedule-edit-helpers — reconcileTaskTime', () => {
  it('derives the missing attribute from the two supplied', () => {
    // start + finish → duration
    assert.strictEqual(
      reconcileTaskTime({ scheduleStart: '2024-05-01T08:00:00Z', scheduleFinish: '2024-05-03T08:00:00Z' })
        ?.scheduleDuration,
      'P2D',
    );
    // start + duration → finish
    assert.strictEqual(
      reconcileTaskTime({ scheduleStart: '2024-05-01T08:00:00Z', scheduleDuration: 'P3D' })
        ?.scheduleFinish,
      '2024-05-04T08:00:00',
    );
  });

  it('rejects finish < start with null (caller must not commit)', () => {
    // This is what gates the Inspector's time edit from committing a
    // negative duration. Returning null explicitly rather than a reconciled
    // object is the signal the caller watches for.
    assert.strictEqual(
      reconcileTaskTime({
        scheduleStart: '2024-05-03T08:00:00Z',
        scheduleFinish: '2024-05-01T08:00:00Z',
      }),
      null,
    );
  });
});

describe('schedule-edit-helpers — cloneExtraction', () => {
  it('breaks mutable-ref aliasing so undo snapshots stay independent', () => {
    // The undo stack depends on this: if snapshots aliased the live
    // extraction's arrays, editing a task after a snapshot would corrupt
    // the snapshot and undo would fail silently.
    const src = {
      hasSchedule: true,
      workSchedules: [],
      sequences: [],
      tasks: [{
        expressId: 1, globalId: 'a', name: 'A', isMilestone: false,
        childGlobalIds: ['child1'], productExpressIds: [10, 20],
        productGlobalIds: ['g1'], controllingScheduleGlobalIds: [],
      }],
    };
    const clone = cloneExtraction(src as never);
    clone.tasks[0].name = 'B';
    clone.tasks[0].productExpressIds.push(99);
    assert.strictEqual(src.tasks[0].name, 'A');
    assert.deepStrictEqual(src.tasks[0].productExpressIds, [10, 20]);
  });
});
