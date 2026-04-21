/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ScheduleExtraction, ScheduleTaskInfo } from '@ifc-lite/parser';
import {
  computeAnimationFrame,
  DEFAULT_ANIMATION_SETTINGS,
  DEFAULT_PALETTE,
  type AnimationSettings,
  type RGBA,
} from './schedule-animator.js';

const DAY = 86_400_000;

function parseDate(iso: string): number {
  return Date.parse(iso.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
}

function makeTask(overrides: Partial<ScheduleTaskInfo>): ScheduleTaskInfo {
  return {
    expressId: 0,
    globalId: 'task-x',
    name: 'Task',
    isMilestone: false,
    childGlobalIds: [],
    productExpressIds: [],
    productGlobalIds: [],
    controllingScheduleGlobalIds: [],
    ...overrides,
  };
}

function makeSchedule(tasks: ScheduleTaskInfo[]): ScheduleExtraction {
  return { hasSchedule: true, workSchedules: [], sequences: [], tasks };
}

// Tests exercise the colour pipeline, which requires style: 'phased'.
// Default is now 'minimal' (see `DEFAULT_ANIMATION_SETTINGS.style`). Unless
// a test is specifically asserting minimal behaviour, wrap with `phased()`.
const settings = (over: Partial<AnimationSettings> = {}): AnimationSettings => ({
  ...DEFAULT_ANIMATION_SETTINGS,
  ...over,
});
const phased = (over: Partial<AnimationSettings> = {}): AnimationSettings => ({
  ...DEFAULT_ANIMATION_SETTINGS,
  style: 'phased',
  ...over,
});

// ─── upcoming / preparation / active / complete ────────────────────────

describe('computeAnimationFrame — standard lifecycle', () => {
  const task = makeTask({
    predefinedType: 'CONSTRUCTION',
    productExpressIds: [1, 2],
    taskTime: { scheduleStart: '2024-05-10T08:00:00Z', scheduleFinish: '2024-05-20T17:00:00Z' },
  });
  const data = makeSchedule([task]);

  it('hides products outside the preparation window when hideBeforePreparation=true', () => {
    const t = parseDate('2024-05-01T00:00:00Z'); // far before start
    const frame = computeAnimationFrame(data, t, settings({ preparationDays: 2 }));
    assert.ok(frame.hiddenIds.has(1));
    assert.ok(frame.hiddenIds.has(2));
    assert.equal(frame.stats['upcoming-far'], 2);
    assert.equal(frame.colorOverrides.size, 0);
  });

  it('does not hide when hideBeforePreparation=false', () => {
    const t = parseDate('2024-05-01T00:00:00Z');
    const frame = computeAnimationFrame(data, t, settings({ hideBeforePreparation: false }));
    assert.equal(frame.hiddenIds.size, 0);
  });

  it('paints the preparation ghost inside the look-ahead window (when opted in)', () => {
    // Default style is minimal + ghost-off — users must opt into both.
    const t = parseDate('2024-05-09T08:00:00Z');
    const frame = computeAnimationFrame(
      data, t, phased({ preparationDays: 2, showPreparationGhost: true }),
    );
    assert.equal(frame.hiddenIds.size, 0);
    assert.equal(frame.stats['upcoming-preparation'], 2);
    const color = frame.colorOverrides.get(1);
    assert.ok(color);
    // Preparation entry in the palette, verbatim (intensity doesn't affect it).
    assert.deepEqual(color, DEFAULT_PALETTE.PREPARATION);
  });

  it('defaults hide upcoming products without drawing a ghost', () => {
    const t = parseDate('2024-05-09T08:00:00Z');
    const frame = computeAnimationFrame(data, t, settings({ preparationDays: 2 }));
    // Default style is 'minimal' — hideBeforePreparation=true kicks in.
    assert.ok(frame.hiddenIds.has(1));
    assert.equal(frame.colorOverrides.size, 0);
  });

  it('paints with task-type colour (scaled by paletteIntensity) in the middle of the active window', () => {
    const t = parseDate('2024-05-15T00:00:00Z'); // ~mid-window
    const frame = computeAnimationFrame(data, t, phased());
    assert.equal(frame.stats.active, 2);
    const color = frame.colorOverrides.get(1)!;
    const expectedAlpha = DEFAULT_PALETTE.CONSTRUCTION[3] * DEFAULT_ANIMATION_SETTINGS.paletteIntensity;
    assert.deepEqual(color.slice(0, 3), DEFAULT_PALETTE.CONSTRUCTION.slice(0, 3));
    assert.equal(color[3], expectedAlpha);
  });

  it('paletteIntensity=1 restores full-strength task-type colour', () => {
    const t = parseDate('2024-05-15T00:00:00Z');
    const frame = computeAnimationFrame(data, t, phased({ paletteIntensity: 1 }));
    assert.deepEqual(frame.colorOverrides.get(1), DEFAULT_PALETTE.CONSTRUCTION);
  });

  it('paletteIntensity=0 suppresses the active-phase override entirely (but phase stats still populate)', () => {
    const t = parseDate('2024-05-15T00:00:00Z');
    const frame = computeAnimationFrame(data, t, phased({ paletteIntensity: 0 }));
    assert.equal(frame.stats.active, 2);
    assert.equal(frame.colorOverrides.size, 0);
  });

  it('ramps opacity up during the first rampInFraction of the window', () => {
    // 5% into the 10-day window: ~0.5 day from start. rampInFraction default 0.08 → inside ramp.
    const start = parseDate('2024-05-10T08:00:00Z');
    const t = start + 0.5 * DAY;
    const frame = computeAnimationFrame(data, t, phased({ paletteIntensity: 1 }));
    assert.equal(frame.stats['active-ramp-in'], 2);
    const color = frame.colorOverrides.get(1)!;
    // Ramp-in alpha < 1 and > 0 at intensity=1
    assert.ok(color[3] > 0);
    assert.ok(color[3] < 1);
  });

  it('fades out (override alpha) during the last fadeOutFraction of the window', () => {
    const finish = parseDate('2024-05-20T17:00:00Z');
    const t = finish - 0.2 * DAY; // ~last 2 %
    const frame = computeAnimationFrame(
      data, t, phased({ fadeOutFraction: 0.10, paletteIntensity: 1 }),
    );
    assert.equal(frame.stats['active-settling'], 2);
    const color = frame.colorOverrides.get(1)!;
    assert.ok(color[3] < 1);
  });

  it('emits no override after the task finishes', () => {
    const t = parseDate('2024-06-01T00:00:00Z');
    const frame = computeAnimationFrame(data, t, settings());
    assert.equal(frame.stats.complete, 2);
    assert.equal(frame.colorOverrides.size, 0);
    assert.equal(frame.hiddenIds.size, 0);
  });
});

// ─── removal tasks (DEMOLITION etc.) ────────────────────────────────────

describe('computeAnimationFrame — removal tasks invert the lifecycle', () => {
  const task = makeTask({
    globalId: 'demo-1',
    predefinedType: 'DEMOLITION',
    productExpressIds: [9],
    taskTime: { scheduleStart: '2024-05-10T00:00:00Z', scheduleFinish: '2024-05-12T00:00:00Z' },
  });
  const data = makeSchedule([task]);

  it('leaves the product visible (no override) before the task starts', () => {
    const frame = computeAnimationFrame(data, parseDate('2024-05-01T00:00:00Z'), settings());
    assert.equal(frame.hiddenIds.size, 0);
    assert.equal(frame.colorOverrides.size, 0);
    assert.equal(frame.stats['upcoming-far'], 1);
  });

  it('fades out with the removal tint while active (phased mode)', () => {
    const frame = computeAnimationFrame(data, parseDate('2024-05-11T00:00:00Z'), phased());
    assert.equal(frame.stats['removal-active'], 1);
    const color = frame.colorOverrides.get(9)!;
    assert.deepEqual(color.slice(0, 3), DEFAULT_PALETTE.DEMOLITION.slice(0, 3));
    assert.ok(color[3] > 0 && color[3] < 1);
  });

  it('hides the product after demolition is complete', () => {
    const frame = computeAnimationFrame(data, parseDate('2024-05-20T00:00:00Z'), settings());
    assert.ok(frame.hiddenIds.has(9));
    assert.equal(frame.stats['removal-complete'], 1);
  });

  it('skips inversion when animateDemolition=false', () => {
    const frame = computeAnimationFrame(
      data,
      parseDate('2024-05-11T00:00:00Z'),
      phased({ animateDemolition: false, paletteIntensity: 1 }),
    );
    // Falls through to the standard construction lifecycle, which paints the
    // DEMOLITION palette colour at full strength (intensity=1) during the
    // active window.
    assert.equal(frame.stats.active, 1);
    assert.deepEqual(frame.colorOverrides.get(9), DEFAULT_PALETTE.DEMOLITION);
  });
});

// ─── minimal style / settings flags ─────────────────────────────────────

describe('computeAnimationFrame — style / flag behaviour', () => {
  const data = makeSchedule([makeTask({
    productExpressIds: [1],
    predefinedType: 'INSTALLATION',
    taskTime: { scheduleStart: '2024-05-10T08:00:00Z', scheduleFinish: '2024-05-20T17:00:00Z' },
  })]);

  it('style=minimal emits visibility-timing hiddenIds but no colour overrides', () => {
    // Active mid-window: nothing is hidden (timing says "visible"), no colour.
    const frame = computeAnimationFrame(
      data, parseDate('2024-05-15T00:00:00Z'),
      settings({ style: 'minimal' }),
    );
    assert.equal(frame.colorOverrides.size, 0);
    assert.equal(frame.hiddenIds.size, 0);
    assert.equal(frame.stats.active, 1);
  });

  it('style=minimal still hides upcoming products (timing layer always active)', () => {
    const frame = computeAnimationFrame(
      data, parseDate('2024-05-01T00:00:00Z'), // before task start
      settings({ style: 'minimal', hideBeforePreparation: true }),
    );
    assert.ok(frame.hiddenIds.has(1));
    assert.equal(frame.colorOverrides.size, 0);
  });

  it('style=minimal still removes demolished products after their task finishes', () => {
    const demo: ScheduleExtraction = {
      hasSchedule: true, workSchedules: [], sequences: [],
      tasks: [{
        expressId: 0, globalId: 'd', name: 'Demo', isMilestone: false,
        predefinedType: 'DEMOLITION', childGlobalIds: [],
        productExpressIds: [7], productGlobalIds: [],
        controllingScheduleGlobalIds: [],
        taskTime: {
          scheduleStart: '2024-05-01T00:00:00Z',
          scheduleFinish: '2024-05-05T00:00:00Z',
        },
      }],
    };
    const frame = computeAnimationFrame(
      demo, parseDate('2024-05-15T00:00:00Z'), // well after the task finishes
      settings({ style: 'minimal', animateDemolition: true }),
    );
    assert.ok(frame.hiddenIds.has(7));
    assert.equal(frame.colorOverrides.size, 0);
  });

  it('colorizeByTaskType=false suppresses the active-window override (phased)', () => {
    const frame = computeAnimationFrame(
      data, parseDate('2024-05-15T00:00:00Z'),
      phased({ colorizeByTaskType: false }),
    );
    assert.equal(frame.stats.active, 1);
    assert.equal(frame.colorOverrides.size, 0);
  });

  it('showPreparationGhost=false respects hideBeforePreparation in the look-ahead window', () => {
    const frame = computeAnimationFrame(
      data, parseDate('2024-05-09T12:00:00Z'),
      phased({ showPreparationGhost: false, hideBeforePreparation: true }),
    );
    assert.ok(frame.hiddenIds.has(1));
    assert.equal(frame.colorOverrides.size, 0);
  });

  it('applies a user-customized palette entry instead of the default', () => {
    const custom = phased({
      paletteIntensity: 1,
      palette: {
        ...DEFAULT_PALETTE,
        INSTALLATION: [1, 0, 1, 1], // full magenta override
      },
    });
    const frame = computeAnimationFrame(
      data, parseDate('2024-05-15T00:00:00Z'), custom,
    );
    assert.deepEqual(frame.colorOverrides.get(1), [1, 0, 1, 1]);
  });
});

// ─── palette / multi-task resolution ───────────────────────────────────

describe('computeAnimationFrame — multi-task resolution', () => {
  it('picks the highest-priority phase when two tasks control the same product', () => {
    // Same product in a prep-phase task and an active-phase task — active wins.
    const prepTask = makeTask({
      globalId: 'prep',
      predefinedType: 'CONSTRUCTION',
      productExpressIds: [42],
      taskTime: { scheduleStart: '2024-05-20T00:00:00Z', scheduleFinish: '2024-05-21T00:00:00Z' },
    });
    const activeTask = makeTask({
      globalId: 'active',
      predefinedType: 'INSTALLATION',
      productExpressIds: [42],
      taskTime: { scheduleStart: '2024-05-10T00:00:00Z', scheduleFinish: '2024-05-30T00:00:00Z' },
    });
    const frame = computeAnimationFrame(
      makeSchedule([prepTask, activeTask]),
      parseDate('2024-05-18T12:00:00Z'),
      phased({ paletteIntensity: 1 }),
    );
    // Active task (INSTALLATION) wins; intensity=1 so the emitted colour
    // equals the palette entry byte-for-byte.
    const colour = frame.colorOverrides.get(42) as RGBA;
    assert.deepEqual(colour, DEFAULT_PALETTE.INSTALLATION);
    assert.equal(frame.stats.active, 1);
  });
});

describe('computeAnimationFrame — schedule filter', () => {
  const tasks = [
    makeTask({
      globalId: 'A', predefinedType: 'CONSTRUCTION',
      productExpressIds: [1],
      controllingScheduleGlobalIds: ['sched-1'],
      taskTime: { scheduleStart: '2024-05-10T00:00:00Z', scheduleFinish: '2024-05-20T00:00:00Z' },
    }),
    makeTask({
      globalId: 'B', predefinedType: 'CONSTRUCTION',
      productExpressIds: [2],
      controllingScheduleGlobalIds: ['sched-2'],
      taskTime: { scheduleStart: '2024-05-10T00:00:00Z', scheduleFinish: '2024-05-20T00:00:00Z' },
    }),
  ];
  it('respects activeWorkScheduleId filter', () => {
    const frame = computeAnimationFrame(
      makeSchedule(tasks),
      parseDate('2024-05-15T00:00:00Z'),
      phased(),
      'sched-1',
    );
    assert.ok(frame.colorOverrides.has(1));
    assert.ok(!frame.colorOverrides.has(2));
  });
});

describe('computeAnimationFrame — defensive inputs', () => {
  it('returns empty frame for null data', () => {
    const frame = computeAnimationFrame(null, Date.now(), settings());
    assert.equal(frame.colorOverrides.size, 0);
    assert.equal(frame.hiddenIds.size, 0);
  });
  it('skips tasks without scheduled times', () => {
    const frame = computeAnimationFrame(
      makeSchedule([makeTask({ productExpressIds: [5] /* no taskTime */ })]),
      Date.now(),
      settings(),
    );
    assert.equal(frame.colorOverrides.size, 0);
  });
});
