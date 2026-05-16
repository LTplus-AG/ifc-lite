/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { validatePlan } from '../authoring/plan.js';
import { planFromPattern } from './plan-stub.js';
import type { MinedPattern } from './types.js';

function pattern(overrides: Partial<MinedPattern> = {}): MinedPattern {
  return {
    sequence: ['model.load', 'lens.apply', 'export.run'],
    occurrences: 7,
    sessionsTouched: 3,
    lastSeenAt: '2026-05-01T00:00:00.000Z',
    score: 0,
    ...overrides,
  };
}

describe('planFromPattern', () => {
  it('produces a plan that passes validatePlan', () => {
    const plan = planFromPattern(pattern());
    expect(validatePlan(plan).ok).toBe(true);
  });

  it('mentions both endpoints in the summary', () => {
    const plan = planFromPattern(pattern());
    expect(plan.summary).toContain('load model');
    expect(plan.summary).toContain('export');
  });

  it('infers the union of intent capabilities', () => {
    const plan = planFromPattern(pattern());
    expect(plan.capabilities).toContain('model.read');
    expect(plan.capabilities).toContain('viewer.colorize');
    expect(plan.capabilities).toContain('export.create:*');
  });

  it('records command + toolbar contributions', () => {
    const plan = planFromPattern(pattern());
    const kinds = plan.contributions.map((c) => c.kind);
    expect(kinds).toContain('command');
    expect(kinds).toContain('toolbar');
  });

  it('includes a fixture-bound test', () => {
    const plan = planFromPattern(pattern());
    expect(plan.tests).toHaveLength(1);
    expect(plan.tests[0].fixture).toBeDefined();
  });

  it('attributes the pattern in notes', () => {
    const plan = planFromPattern(pattern({ occurrences: 4, sessionsTouched: 2 }));
    expect(plan.notes).toContain('4 times');
    expect(plan.notes).toContain('2 session');
  });

  it('handles a single-intent pattern', () => {
    const plan = planFromPattern(pattern({ sequence: ['export.run'] }));
    expect(validatePlan(plan).ok).toBe(true);
    expect(plan.summary).toContain('export');
  });
});
