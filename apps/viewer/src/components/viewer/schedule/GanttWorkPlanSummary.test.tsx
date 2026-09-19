/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkScheduleInfo } from '@ifc-lite/parser';
import { cleanup, render } from '@/test/render.js';
import { GanttWorkPlanSummary } from './GanttWorkPlanSummary.js';
import { GanttEmptyState } from './GanttEmptyState.js';

function workSchedule(
  globalId: string,
  name: string,
  parentPlanGlobalId?: string,
): WorkScheduleInfo {
  return {
    expressId: 1,
    globalId,
    kind: 'WorkSchedule',
    name,
    taskGlobalIds: [],
    parentPlanGlobalId,
  };
}

function workPlan(
  globalId: string,
  name: string,
  childScheduleGlobalIds: string[] = [],
): WorkScheduleInfo {
  return {
    expressId: 2,
    globalId,
    kind: 'WorkPlan',
    name,
    taskGlobalIds: [],
    childScheduleGlobalIds,
  };
}

afterEach(cleanup);

describe('GanttWorkPlanSummary', () => {
  it('shows multiple plans, their schedule links, an empty plan, and ungrouped schedules (#4834)', () => {
    const ui = render(<GanttWorkPlanSummary workSchedules={[
      workPlan('plan-a', 'Delivery plan', ['schedule-a']),
      workSchedule('schedule-a', 'Shell programme'),
      workPlan('plan-b', 'Fit-out plan'),
      // Exercise the reverse link independently of childScheduleGlobalIds.
      workSchedule('schedule-b', 'Fit-out programme', 'plan-b'),
      workPlan('plan-empty', 'Future works'),
      workSchedule('schedule-loose', 'Site logistics'),
    ]} />);

    assert.match(ui.textContent ?? '', /Work plans/);
    assert.match(ui.textContent ?? '', /Delivery plan.*Shell programme/);
    assert.match(ui.textContent ?? '', /Fit-out plan.*Fit-out programme/);
    assert.match(ui.textContent ?? '', /Future works.*No nested schedules/);
    assert.match(ui.textContent ?? '', /Ungrouped: Site logistics/);
    assert.equal(ui.querySelectorAll('[title^="IfcWorkPlan "]').length, 3);
  });

  it('renders nothing when the extraction has no IfcWorkPlan', () => {
    const ui = render(<GanttWorkPlanSummary workSchedules={[
      workSchedule('schedule-only', 'Main programme'),
    ]} />);

    assert.equal(ui.querySelector('[data-testid="gantt-work-plan-summary"]'), null);
  });

  it('keeps the empty state truthful for a plan with no tasks', () => {
    const ui = render(<GanttEmptyState loading={false} hasModel hasWorkPlans />);

    assert.match(ui.textContent ?? '', /No scheduled tasks/);
    assert.match(ui.textContent ?? '', /IfcWorkPlan.*shown above/);
    assert.doesNotMatch(ui.textContent ?? '', /No schedule found/);
  });
});
