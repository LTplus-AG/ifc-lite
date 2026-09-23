/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `unit` requirement checking (#5300): "Width is recorded in mm". Per
 * element, like `compare`. `readSubject` reports the unit every value of a
 * property/quantity subject is recorded in (its explicit `Unit`, else the
 * project unit for its measure type); an element passes when the subject
 * is present and EVERY value is recorded in the required unit.
 *
 * Units compare by display symbol, the one spelling the viewer shows for a
 * unit (`mm`, `m²`), after folding the ASCII exponent spellings a person
 * types (`m2`, `m^2`) onto the superscripts the resolver emits. Nothing
 * else is folded: `mm` and `Mm` are different units.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { EntityResult, FailureReasonCode } from '@ifc-lite/ids';
import type { FilteredElement } from '../filter/filter-evaluate.js';
import { readSubject } from '../filter/read-subject.js';
import type { UnitRequirement } from '../rule-set/rule-set.js';
import { baseRow, describeSubject } from './rule-engine-sets.js';
import { maybeYieldChunk, finalProgress, type RuleEngineProgress } from './rule-engine-chunk.js';

const SUPERSCRIPT: Readonly<Record<string, string>> = { '2': '²', '3': '³' };

/** `m2` / `m^2` / `m²` all read as `m²`; everything else is compared as typed. */
export function normalizeUnitSymbol(symbol: string): string {
  return symbol.trim().replace(/([A-Za-zµ])\^?([23])(?![0-9])/g, (_, base: string, exp: string) => `${base}${SUPERSCRIPT[exp]}`);
}

/** What a value's unit reads as in a failure message. */
function unitLabel(unit: string | undefined): string {
  return unit ?? 'no unit';
}

export async function checkUnit(
  requirementId: string,
  requirement: UnitRequirement,
  applicable: readonly FilteredElement[],
  storesById: ReadonlyMap<string, IfcDataStore>,
  ruleIndex: number,
  signal: AbortSignal | undefined,
  onProgress: ((p: RuleEngineProgress) => void) | undefined,
): Promise<{ entityResults: EntityResult[] }> {
  const wanted = normalizeUnitSymbol(requirement.unit);
  // A blank unit is an unfinished rule, not a check every element fails:
  // report it as the rule's error (`rule-engine.ts`'s per-rule guard).
  if (wanted.length === 0) throw new Error('the unit requirement names no unit');
  const label = `${describeSubject(requirement.subject)} recorded in ${wanted}`;
  const facetType = requirement.subject.kind;
  const entityResults: EntityResult[] = [];

  for (let i = 0; i < applicable.length; i++) {
    const el = applicable[i];
    const store = storesById.get(el.modelId);
    if (!store) { await maybeYieldChunk(i + 1, applicable.length, ruleIndex, signal, onProgress); continue; }
    const subject = readSubject(requirement.subject, { store, expressId: el.expressId });

    let passed = false;
    let reason: FailureReasonCode | undefined;
    let actual = '""';
    if (subject.present) {
      // Only the values that are actually there: an explicitly empty label
      // next to a real one is not a second, unit-less recording.
      const recorded = subject.values
        .map((value, index) => ({ value: String(value), unit: subject.valueUnits?.[index] }))
        .filter((v) => v.value.trim().length > 0);
      actual = recorded.map((v) => `${v.value} ${unitLabel(v.unit)}`).join('; ');
      passed = recorded.length > 0
        && recorded.every((v) => v.unit !== undefined && normalizeUnitSymbol(v.unit) === wanted);
      reason = passed ? undefined : 'mismatch';
    } else {
      reason = 'absent';
    }

    entityResults.push(baseRow(el, passed, {
      requirement: { id: requirementId, label, optionality: 'required' },
      status: passed ? 'pass' : 'fail',
      facetType,
      checkedDescription: label,
      failureReason: reason,
      actualValue: actual,
      expectedValue: wanted,
    }));
    await maybeYieldChunk(i + 1, applicable.length, ruleIndex, signal, onProgress);
  }
  finalProgress(applicable.length, ruleIndex, signal, onProgress);
  return { entityResults };
}
