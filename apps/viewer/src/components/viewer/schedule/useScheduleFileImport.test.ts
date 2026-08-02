/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the pure decision logic pulled out of
 * `useScheduleFileImport` — the size guard, the clobber-confirm decision,
 * and both toast paths. All three were added because of earlier review
 * rounds (issue #1890) and shipped with no tests of their own; this file
 * pins them the same way `useGanttBarDrag.test.ts` pins that hook's pure
 * math, without rendering the hook itself (no React Testing Library in
 * this repo — FileReader/DOM event plumbing is exercised manually).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  exceedsImportSizeLimit,
  formatSizeLimitError,
  shouldConfirmClobber,
  describeImportOutcome,
} from './useScheduleFileImport.js';
import type { ScheduleImportResult } from './import/index.js';

function makeResult(over: Partial<ScheduleImportResult> = {}): ScheduleImportResult {
  return {
    extraction: { workSchedules: [], tasks: [], sequences: [], hasSchedule: true },
    warnings: [],
    format: 'csv',
    taskCount: 3,
    sequenceCount: 1,
    ...over,
  };
}

describe('exceedsImportSizeLimit', () => {
  it('is false at and under the limit', () => {
    assert.strictEqual(exceedsImportSizeLimit(1000, 1000), false);
    assert.strictEqual(exceedsImportSizeLimit(999, 1000), false);
  });

  it('is true over the limit', () => {
    assert.strictEqual(exceedsImportSizeLimit(1001, 1000), true);
  });
});

describe('formatSizeLimitError', () => {
  it('names the file, its size in MB, and the limit', () => {
    const msg = formatSizeLimitError('big.csv', 25 * 1024 * 1024, 20 * 1024 * 1024);
    assert.match(msg, /"big\.csv"/);
    assert.match(msg, /25\.0 MB/);
    assert.match(msg, /20 MB import limit/);
  });
});

describe('shouldConfirmClobber', () => {
  it('is false when there is no schedule loaded', () => {
    assert.strictEqual(shouldConfirmClobber(null, false), false);
  });

  it('is false when the schedule has no tasks', () => {
    assert.strictEqual(shouldConfirmClobber({ tasks: [] }, false), false);
  });

  it('is false for a purely generated, untouched schedule (no model-extracted tasks, not edited)', () => {
    assert.strictEqual(
      shouldConfirmClobber({ tasks: [{ expressId: 0 }, { expressId: 0 }] }, false),
      false,
    );
  });

  it('is true when the schedule has been hand-edited', () => {
    assert.strictEqual(
      shouldConfirmClobber({ tasks: [{ expressId: 0 }] }, true),
      true,
    );
  });

  it('is true when any task was read from the IFC model (expressId > 0)', () => {
    assert.strictEqual(
      shouldConfirmClobber({ tasks: [{ expressId: 0 }, { expressId: 42 }] }, false),
      true,
    );
  });
});

describe('describeImportOutcome', () => {
  it('reports success with singular wording for exactly one task/dependency and no warnings', () => {
    const result = makeResult({ taskCount: 1, sequenceCount: 1, warnings: [] });
    const outcome = describeImportOutcome(result, 'plan.csv');
    assert.strictEqual(outcome.kind, 'success');
    assert.match(outcome.message, /Imported 1 task, 1 dependency from "plan\.csv"/);
  });

  it('reports success with plural wording for zero/many counts', () => {
    const result = makeResult({ taskCount: 0, sequenceCount: 5, warnings: [] });
    const outcome = describeImportOutcome(result, 'plan.csv');
    assert.match(outcome.message, /0 tasks, 5 dependencies/);
  });

  it('reports warning kind and includes a preview of the first two warnings', () => {
    const result = makeResult({
      warnings: [
        { code: 'unparsable-date', message: 'bad date A' },
        { code: 'unparsable-date', message: 'bad date B' },
        { code: 'unparsable-date', message: 'bad date C' },
      ],
    });
    const outcome = describeImportOutcome(result, 'plan.csv');
    assert.strictEqual(outcome.kind, 'warning');
    assert.match(outcome.message, /3 warnings:/);
    assert.match(outcome.message, /bad date A/);
    assert.match(outcome.message, /bad date B/);
    // Preview caps at 2 — the third message is not inlined into the toast
    // (it's still in the full console log the hook writes separately).
    assert.ok(!outcome.message.includes('bad date C'));
  });

  it('uses singular "warning" wording for exactly one warning', () => {
    const result = makeResult({ warnings: [{ code: 'unparsable-date', message: 'bad date' }] });
    const outcome = describeImportOutcome(result, 'plan.csv');
    assert.match(outcome.message, /1 warning:/);
    assert.ok(!outcome.message.includes('1 warnings'));
  });

  it('always mentions that tasks are not linked to IFC elements', () => {
    const outcome = describeImportOutcome(makeResult(), 'plan.csv');
    assert.match(outcome.message, /not linked to IFC elements/);
  });
});
