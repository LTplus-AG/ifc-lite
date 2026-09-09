/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coverage-message wording for the 'partial' outcome (#4244 follow-up).
 *
 * `classifyRuleCoverage` folds two structurally different causes into the
 * single 'partial' outcome (deliberately — see analysis.ts): a rule whose
 * selector matched nothing (ruleHadNoMatch), and a rule whose selectors
 * matched elements on both sides yet the geometry kernel examined zero
 * candidate pairs (ruleCoverageWasUnexamined, e.g. a NaN-poisoned tolerance
 * or an exhausted maxCandidatePairs budget). Before this fix, the CLI's
 * "Note: N of M rule(s) never ran a comparison" line counted the unexamined
 * rule in N but never listed it (its describer only knew ruleHadNoMatch),
 * producing a confusing, content-free trailing colon. These tests build
 * hand-crafted `ClashResult` fixtures (no meshing, no wasm) so they run
 * without the CLI's built dist/wasm runtime.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ClashResult, ClashRule, ClashRuleCoverage } from '@ifc-lite/clash';

// clash.ts's module-level imports pull in the full headless-context chain
// (../loader.js -> @ifc-lite/sdk -> @ifc-lite/parser -> ...), which this
// environment cannot resolve (see TEST-ENV.md: workspace dist is stale /
// partially borrowed across worktrees). None of that chain is exercised by
// the pure coverage-message functions under test here, so it is stubbed out.
vi.mock('../loader.js', () => ({ createHeadlessContext: vi.fn() }));

const {
  emptyRuleDescriptions,
  unexaminedRuleDescriptions,
  printCoverageWarning,
} = await import('./clash.js');

function rule(id: string, name: string, b: string | undefined = 'IfcRoof'): ClashRule {
  return { id, name, a: 'IfcBeam', b, mode: 'hard' };
}

function baseResult(rulesRun: ClashRule[], ruleCoverage: ClashRuleCoverage[]): ClashResult {
  return {
    clashes: [],
    summary: { total: 0, byRule: {}, byTypePair: {}, bySeverity: { critical: 0, major: 0, minor: 0, info: 0 } },
    rulesRun,
    ruleCoverage,
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  };
}

function captureStdout(): { text(): string; restore(): void } {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  return { text: () => out, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('unexaminedRuleDescriptions vs emptyRuleDescriptions (#4244)', () => {
  it('an unexamined-but-matched rule produces a non-empty, distinct message naming that rule', () => {
    const rules = [rule('r1', 'MEP vs Structure')];
    const coverage: ClashRuleCoverage[] = [
      { rule: 'r1', matchedA: 5, matchedB: 3, candidatesProcessed: 0 },
    ];
    const result = baseResult(rules, coverage);

    const unexamined = unexaminedRuleDescriptions(result);
    const empty = emptyRuleDescriptions(result);

    expect(empty).toEqual([]); // both sides matched — never "empty selector"
    expect(unexamined).toHaveLength(1);
    expect(unexamined[0]).toContain('MEP vs Structure');
    expect(unexamined[0]).toContain('0 candidate pairs');
    // The two wordings must not collide — a reader has to be able to tell
    // "nothing to compare" apart from "had things to compare and didn't".
    expect(unexamined[0]).not.toContain('matched 0 elements');
  });

  it("an existing selector-empty rule's message is unchanged", () => {
    const rules = [rule('r1', 'Beam vs Roof')];
    const coverage: ClashRuleCoverage[] = [{ rule: 'r1', matchedA: 4, matchedB: 0 }];
    const result = baseResult(rules, coverage);

    expect(emptyRuleDescriptions(result)).toEqual([
      '"Beam vs Roof": selector B ("IfcRoof") matched 0 elements',
    ]);
    expect(unexaminedRuleDescriptions(result)).toEqual([]);
  });

  it('a fully clean run (every rule matched and examined at least one pair) yields both lists empty', () => {
    const rules = [rule('r1', 'Beam vs Roof')];
    const coverage: ClashRuleCoverage[] = [{ rule: 'r1', matchedA: 4, matchedB: 2, candidatesProcessed: 8 }];
    const result = baseResult(rules, coverage);

    expect(emptyRuleDescriptions(result)).toEqual([]);
    expect(unexaminedRuleDescriptions(result)).toEqual([]);
  });
});

describe('printCoverageWarning partial-outcome wording (#4244)', () => {
  it('prints a distinct, non-empty WARNING for an unexamined-but-matched rule, with no empty-selector Note', () => {
    // Second rule is a normal clean rule so the overall outcome is 'partial',
    // not 'no-match' (classifyRuleCoverage requires ALL rules empty for that).
    const rules = [rule('r1', 'MEP vs Structure'), rule('r2', 'Clean rule')];
    const coverage: ClashRuleCoverage[] = [
      { rule: 'r1', matchedA: 5, matchedB: 3, candidatesProcessed: 0 },
      { rule: 'r2', matchedA: 2, matchedB: 2, candidatesProcessed: 4 },
    ];
    const result = baseResult(rules, coverage);

    const cap = captureStdout();
    try {
      printCoverageWarning(result, true);
    } finally {
      cap.restore();
    }
    const text = cap.text();

    expect(text).toContain('WARNING');
    expect(text).toContain('MEP vs Structure');
    expect(text).toContain('0 candidate pairs');
    // No selector-empty rules exist in this fixture, so the old "Note: N of M
    // rule(s) never ran a comparison" line (with its now-confusing empty
    // trailing colon) must not appear at all.
    expect(text).not.toContain('never ran a');
  });

  it('an ordinary clean run prints nothing new', () => {
    const rules = [rule('r1', 'Clean rule')];
    const coverage: ClashRuleCoverage[] = [{ rule: 'r1', matchedA: 4, matchedB: 2, candidatesProcessed: 8 }];
    const result = baseResult(rules, coverage);

    const cap = captureStdout();
    try {
      printCoverageWarning(result, true);
    } finally {
      cap.restore();
    }
    expect(cap.text()).toBe('');
  });

  it('an existing selector-empty-only partial run keeps its current Note wording unchanged', () => {
    const rules = [rule('r1', 'Beam vs Roof'), rule('r2', 'Clean rule')];
    const coverage: ClashRuleCoverage[] = [
      { rule: 'r1', matchedA: 4, matchedB: 0 },
      { rule: 'r2', matchedA: 2, matchedB: 2, candidatesProcessed: 4 },
    ];
    const result = baseResult(rules, coverage);

    const cap = captureStdout();
    try {
      printCoverageWarning(result, true);
    } finally {
      cap.restore();
    }
    const text = cap.text();
    expect(text).toContain('Note: 1 of 2 rule(s) never ran a comparison');
    expect(text).toContain('"Beam vs Roof": selector B ("IfcRoof") matched 0 elements');
    expect(text).not.toContain('WARNING');
  });
});
