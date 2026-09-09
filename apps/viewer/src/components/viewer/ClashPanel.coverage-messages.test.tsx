/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `classifyRuleCoverage` folds two structurally different causes into a
 * single 'partial' outcome (deliberately — see packages/clash/src/analysis.ts):
 * a rule whose selector matched nothing (`ruleHadNoMatch`), and a rule that
 * matched elements on BOTH sides yet the geometry kernel examined zero
 * candidate pairs (`ruleCoverageWasUnexamined`, #4244 — e.g. a non-finite
 * tolerance/clearance, or an exhausted candidate-pair budget). Before this
 * fix, `ClashPanel`'s explanatory paragraph was built only from
 * `emptyRuleNames` (selector-empty only), so a rule that matched selectors
 * but was never examined rendered NO explanation at all — the panel just
 * said "No clashes found for this rule set. 🎉", which is false comfort: a
 * real comparison silently never happened.
 *
 * These tests render the REAL `ClashPanel` against a seeded store (same
 * pattern as ClashPanel.test.tsx) so a failure here means the panel itself
 * doesn't surface the unexamined case, not that the classification is wrong
 * (that's covered in packages/clash).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { summarizeClashes, type ClashResult, type ClashRuleCoverage } from '@ifc-lite/clash';
import { ClashPanel } from './ClashPanel.js';

Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 400 });

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function renderPanel(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ClashPanel />);
  });
  mounted.push({ root, container });
  return container;
}

function resetStore(): void {
  useViewerStore.setState({
    clashResult: null,
    clashGroups: null,
    clashSelectedId: null,
    clashSortBy: 'severity',
    clashHideTouching: false,
    clashStatusFilter: new Set(['open', 'resolved', 'accepted']),
  });
}

function baseResult(rulesRun: ClashResult['rulesRun'], ruleCoverage: ClashRuleCoverage[]): ClashResult {
  return {
    clashes: [],
    summary: summarizeClashes([]),
    rulesRun,
    ruleCoverage,
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

describe('ClashPanel unexamined-rule wording (#4244)', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
    resetStore();
  });

  it('a rule that matched elements but examined 0 candidate pairs renders a non-empty, distinct explanation', () => {
    const rulesRun = [
      { id: 'r1', name: 'MEP vs Structure', a: 'IfcDuct', b: 'IfcBeam', mode: 'hard' as const },
      { id: 'r2', name: 'Clean rule', a: 'IfcWall', b: 'IfcSlab', mode: 'hard' as const },
    ];
    const ruleCoverage: ClashRuleCoverage[] = [
      { rule: 'r1', matchedA: 5, matchedB: 3, candidatesProcessed: 0 },
      { rule: 'r2', matchedA: 2, matchedB: 2, candidatesProcessed: 4 },
    ];
    const result = baseResult(rulesRun, ruleCoverage);
    useViewerStore.setState({ clashResult: result, clashGroups: [] });

    const container = renderPanel();
    const text = container.textContent ?? '';

    // The alarming case must be named — no empty-selector rules exist in
    // this fixture, so the old "matched no elements and never ran" wording
    // (which does not apply here) must not appear either.
    assert.ok(text.includes('MEP vs Structure'), `expected the unexamined rule name in: ${text}`);
    assert.ok(text.includes('0 candidate pairs'), `expected the "0 candidate pairs" explanation in: ${text}`);
    assert.ok(
      !text.includes('matched no elements and never ran'),
      `must not reuse the selector-empty wording for an unexamined rule: ${text}`,
    );
    // The celebratory clean-run message must not appear — a comparison
    // silently didn't happen, that's not something to celebrate.
    assert.ok(!text.includes('No clashes found for this rule set. 🎉'), `must not render the clean-run 🎉 message: ${text}`);
  });

  it("a selector-empty rule's existing explanation is unchanged", () => {
    const rulesRun = [
      { id: 'r1', name: 'Beam vs Roof', a: 'IfcBeam', b: 'IfcRoof', mode: 'hard' as const },
      { id: 'r2', name: 'Clean rule', a: 'IfcWall', b: 'IfcSlab', mode: 'hard' as const },
    ];
    const ruleCoverage: ClashRuleCoverage[] = [
      { rule: 'r1', matchedA: 4, matchedB: 0 },
      { rule: 'r2', matchedA: 2, matchedB: 2, candidatesProcessed: 4 },
    ];
    const result = baseResult(rulesRun, ruleCoverage);
    useViewerStore.setState({ clashResult: result, clashGroups: [] });

    const container = renderPanel();
    const text = container.textContent ?? '';

    assert.ok(
      text.includes('1 rule(s) matched no elements and never ran: Beam vs Roof'),
      `expected the unchanged selector-empty wording in: ${text}`,
    );
    assert.ok(text.includes('No clashes found for this rule set. 🎉'), `clean 🎉 header must still render alongside the note: ${text}`);
    assert.ok(!text.includes('0 candidate pairs'), `must not mention the unexamined wording: ${text}`);
  });

  it('an ordinary clean run (every rule matched and examined at least one pair) prints nothing new', () => {
    const rulesRun = [{ id: 'r1', name: 'Clean rule', a: 'IfcWall', b: 'IfcSlab', mode: 'hard' as const }];
    const ruleCoverage: ClashRuleCoverage[] = [{ rule: 'r1', matchedA: 2, matchedB: 2, candidatesProcessed: 4 }];
    const result = baseResult(rulesRun, ruleCoverage);
    useViewerStore.setState({ clashResult: result, clashGroups: [] });

    const container = renderPanel();
    const text = container.textContent ?? '';

    assert.ok(text.includes('No clashes found for this rule set. 🎉'), `expected the plain clean message in: ${text}`);
    assert.ok(!text.includes('0 candidate pairs'), `must not mention the unexamined wording on a clean run: ${text}`);
    assert.ok(!text.includes('matched no elements and never ran'), `must not mention the empty-selector wording on a clean run: ${text}`);
    assert.ok(!text.includes('doesn\'t mean this model is clean'), `must not mention the warning wording on a clean run: ${text}`);
  });
});
