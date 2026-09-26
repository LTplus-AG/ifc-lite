/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, press, render } from '@/test/render.js';
import type { ScheduleExtraction } from '@ifc-lite/parser';
import { GanttTimeline } from './GanttTimeline.js';
import { advanceCalendarTime } from './schedule-utils.js';

const DAY = 86_400_000;
const data: ScheduleExtraction = { tasks: [], workSchedules: [], sequences: [], hasSchedule: false };

afterEach(cleanup);

it('#5823 seeks the Gantt timeline with arrow, Home, and End keys', () => {
  const seeks: number[] = [];
  const ui = render(
    <GanttTimeline
      rows={[]}
      data={data}
      range={{ start: 0, end: 3 * DAY, synthetic: false }}
      scale="day"
      playbackTime={DAY}
      selectedGlobalIds={new Set()}
      hoveredGlobalId={null}
      onSelect={() => {}}
      onHover={() => {}}
      onScrubSeek={(time) => seeks.push(time)}
      scrollTop={0}
      onScroll={() => {}}
    />,
  );
  const timeline = ui.querySelector<SVGSVGElement>('svg[role="slider"]');
  assert.ok(timeline, 'timeline must be keyboard focusable');
  assert.match(timeline.getAttribute('aria-valuetext') ?? '', /1970/);
  press(timeline, 'ArrowRight');
  assert.equal(seeks.at(-1), 2 * DAY);
  press(timeline, 'ArrowLeft');
  assert.equal(seeks.at(-1), 0);
  press(timeline, 'Home');
  assert.equal(seeks.at(-1), 0);
  press(timeline, 'End');
  assert.equal(seeks.at(-1), 3 * DAY);
});

it('#5823 seeks in calendar units across month ends and daylight saving time', () => {
  const previousTimezone = process.env.TZ;
  try {
    process.env.TZ = 'Europe/Zurich';
    assert.equal(
      advanceCalendarTime(new Date(2025, 0, 31, 12).getTime(), 'month', 1),
      new Date(2025, 1, 28, 12).getTime(),
    );
    assert.equal(
      advanceCalendarTime(new Date(2025, 2, 29, 12).getTime(), 'day', 1),
      new Date(2025, 2, 30, 12).getTime(),
    );
    const firstZurich0230 = new Date('2025-10-26T00:30:00Z').getTime();
    const secondZurich0230 = new Date('2025-10-26T01:30:00Z').getTime();
    assert.equal(new Date(firstZurich0230).getHours(), 2);
    assert.equal(new Date(secondZurich0230).getHours(), 2);
    assert.equal(advanceCalendarTime(firstZurich0230, 'hour', 1), secondZurich0230);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});
