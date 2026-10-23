/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SpecificationResult } from '@ifc-lite/ids';
import { cleanup, render } from '@/test/render.js';
import { SpecificationCard } from './IDSSpecificationCard';
import { ValidationBenchmark } from './validation/ValidationBenchmark';

// #8065: 128 entities each pass ten requirements and fail one. The entity
// verdict stays failed, but the requirement-check percentage is 1280/1408.
function result(): SpecificationResult {
  return {
    specification: { id: 'walls', name: 'Wall requirements' },
    status: 'fail', applicableCount: 128, passedCount: 0, failedCount: 128, passRate: 0,
    entityResults: Array.from({ length: 128 }, (_, i) => ({
      modelId: 'model', expressId: i + 1, entityType: 'IfcWall', passed: false,
      requirementResults: Array.from({ length: 11 }, (_, j) => ({
        requirement: { id: `r${j}`, label: `Requirement ${j}`, optionality: 'required' as const },
        status: j === 10 ? 'fail' as const : 'pass' as const,
        facetType: 'attribute' as const, checkedDescription: 'Required attribute',
      })),
    })),
  };
}
function card(value: SpecificationResult, isIDS = true) {
  return render(<SpecificationCard result={value} isIDS={isIDS} isActive={false} onSelect={() => {}}
    onEntityClick={() => {}} onIsolateSet={() => {}} filterMode="all" />);
}
afterEach(cleanup);

describe('IDS percentages (#8065)', () => {
  it('shows the requirement rate in the main bar while retaining the failed entity verdict', () => {
    const ui = card(result());
    assert.ok(ui.querySelector('[style="width: 90%;"]'));
    assert.match(ui.textContent ?? '', /1,280\/1,408 checks passed \(90%\)/);
    assert.match(ui.textContent ?? '', /128 failed/);
    assert.ok(ui.querySelector('[role="status"][aria-label="Failed"]'));
  });

  for (const status of ['pass', 'fail', 'not_applicable'] as const) {
    it(`shows zero matches as Not checked at 0% while preserving ${status}`, () => {
      const ui = card({ ...result(), status, applicableCount: 0, passedCount: 0, failedCount: 0, passRate: 100, entityResults: [] });
      assert.ok(ui.querySelector('[style="width: 0%;"]'));
      assert.match(ui.textContent ?? '', /0%Not checked/);
      assert.doesNotMatch(ui.textContent ?? '', /100%/);
    });
  }

  it('keeps rule-set and incomplete-report percentages from the engine', () => {
    let ui = card(result(), false);
    assert.ok(ui.querySelector('[style="width: 0%;"]'));
    cleanup();
    const partial = result();
    partial.entityResults = partial.entityResults.slice(0, 1);
    ui = card(partial);
    assert.ok(ui.querySelector('[style="width: 0%;"]'));
  });

  it('lists unmatched specifications under Not checked without inventing entities for the benchmark', () => {
    const ui = render(<ValidationBenchmark summary={{ checked: 128, passed: 0, failed: 128, passRate: 0 }}
      name="Walls" notCheckedSpecifications={2} />);
    assert.match(ui.textContent ?? '', /Not checked: 2 specifications/);
    assert.match(ui.querySelector('img')?.alt ?? '', /128 failed/);
  });
});
