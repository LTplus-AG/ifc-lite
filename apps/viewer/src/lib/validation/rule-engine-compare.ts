/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `compare` requirement checking (#5138 PR 3, plan §4.7) — split out of
 * `rule-engine-sets.ts` once that file crossed the module-size budget.
 * Per-entity like `element` (reads two `Subject`s instead of matching one
 * against an operand), not a set kind — reuses `describeSubject`/`baseRow`
 * from `rule-engine-sets.ts` rather than duplicating them.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { CheckKind, EntityResult, FailureReasonCode } from '@ifc-lite/ids';
import { numericOpMatches } from '../search/filter-ops.js';
import type { FilteredElement } from '../search/filter-evaluate.js';
import { readSubject } from '../search/read-subject.js';
import type { CompareRequirement } from './rule-set.js';
import { OP_LABEL, type ValidationOpts } from './rule-engine-requirements.js';
import { baseRow, describeSubject } from './rule-engine-sets.js';
import { maybeYieldChunk, finalProgress, type RuleEngineProgress } from './rule-engine-chunk.js';

/** ISO-8601 date or date-time — plan §4.7. No locale formats, no
 *  `IfcCalendarDate` reconstruction (deferred, plan §10). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export async function checkCompare(
  requirementId: string,
  requirement: CompareRequirement,
  applicable: readonly FilteredElement[],
  storesById: ReadonlyMap<string, IfcDataStore>,
  opts: ValidationOpts,
  ruleIndex: number,
  signal: AbortSignal | undefined,
  onProgress: ((p: RuleEngineProgress) => void) | undefined,
): Promise<{ entityResults: EntityResult[] }> {
  const expected = `${describeSubject(requirement.left)} ${OP_LABEL[requirement.op]} ${describeSubject(requirement.right)}`;
  const facetType: CheckKind = 'compare';
  const entityResults: EntityResult[] = [];

  for (let i = 0; i < applicable.length; i++) {
    const el = applicable[i];
    const store = storesById.get(el.modelId);
    if (!store) { await maybeYieldChunk(i + 1, applicable.length, ruleIndex, signal, onProgress); continue; }
    const ctx = { store, expressId: el.expressId };
    const left = readSubject(requirement.left, ctx);
    const right = readSubject(requirement.right, ctx);
    let passed = false;
    let reason: FailureReasonCode | undefined;
    let actual: string;

    if (!left.present || !right.present) {
      reason = 'absent';
      actual = `${left.present ? String(left.values[0]) : '""'} ⟂ ${right.present ? String(right.values[0]) : '""'}`;
    } else if ((requirement.valueType ?? 'number') === 'date') {
      const lv = String(left.values[0]);
      const rv = String(right.values[0]);
      actual = `${lv} ⟂ ${rv}`;
      const lOk = ISO_DATE_RE.test(lv) && Number.isFinite(Date.parse(lv));
      const rOk = ISO_DATE_RE.test(rv) && Number.isFinite(Date.parse(rv));
      if (!lOk || !rOk) {
        reason = 'notDate';
      } else {
        passed = numericOpMatches(requirement.op, Date.parse(lv), Date.parse(rv));
        reason = passed ? undefined : 'mismatch';
      }
    } else {
      const lv = Number(left.values[0]);
      const rv = Number(right.values[0]);
      actual = `${left.values[0]} ⟂ ${right.values[0]}`;
      if (!Number.isFinite(lv) || !Number.isFinite(rv)) {
        reason = 'notNumeric';
      } else {
        passed = numericOpMatches(requirement.op, lv, rv, opts);
        reason = passed ? undefined : 'mismatch';
      }
    }

    entityResults.push(baseRow(el, passed, {
      requirement: { id: requirementId, label: expected, optionality: 'required' },
      status: passed ? 'pass' : 'fail', facetType, checkedDescription: expected,
      failureReason: passed ? undefined : reason, actualValue: actual, expectedValue: expected,
    }));
    await maybeYieldChunk(i + 1, applicable.length, ruleIndex, signal, onProgress);
  }
  finalProgress(applicable.length, ruleIndex, onProgress);
  return { entityResults };
}
