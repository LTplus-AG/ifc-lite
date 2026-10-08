/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lint precision measurement (IDS-054, FR-C05).
 *
 * Every finding on a labelled corpus file must be explained by a label:
 * either a per-finding verdict (`file|code|message`) or, for `info` rules
 * whose condition is a plain fact about the document (no description, an
 * exact real comparison, …), a rule-level verdict. Unlabelled findings
 * count as false positives, so a new rule cannot raise precision by
 * staying silent about its findings.
 *
 * precision = justified / (justified + falsePositive + unlabelled)
 */

import type { IDSDocument } from '@ifc-lite/ids';
import { fromIdsDocument } from '../document/from-ids.js';
import { lintDocument } from './engine.js';
import type { LintContext, LintSeverity } from './types.js';

export interface Verdict {
  verdict: 'justified' | 'false-positive';
  reason: string;
}

export interface PrecisionLabels {
  /** Rule-level verdicts, allowed for `info` rules only. */
  rules: Record<string, Verdict>;
  /** Per-finding verdicts keyed `file|code|message`. */
  findings: Record<string, Verdict>;
}

export interface PrecisionCase {
  file: string;
  ids: IDSDocument;
}

/** Findings of one rule at one severity (a rule may demote individual findings). */
export interface RuleTally {
  code: string;
  severity: LintSeverity;
  justified: number;
  falsePositive: number;
  unlabelled: number;
}

export interface PrecisionReport {
  files: number;
  findings: number;
  precision: number;
  /** Precision over warning and error findings only. */
  precisionWarnError: number;
  rules: RuleTally[];
  unlabelled: string[];
  falsePositives: string[];
  /** Labels that matched no finding (stale). */
  unusedLabels: string[];
}

function ratio(good: number, all: number): number {
  return all === 0 ? 1 : good / all;
}

export function findingKey(file: string, code: string, message: string): string {
  return `${file}|${code}|${message}`;
}

export function measurePrecision(cases: readonly PrecisionCase[], labels: PrecisionLabels, ctx: LintContext): PrecisionReport {
  const tallies = new Map<string, RuleTally>();
  const unlabelled: string[] = [];
  const falsePositives: string[] = [];
  const used = new Set<string>();
  let findings = 0;
  for (const c of cases) {
    const { diagnostics } = lintDocument(fromIdsDocument(c.ids), ctx);
    for (const d of diagnostics) {
      findings++;
      const key = findingKey(c.file, d.code, d.message);
      const tallyKey = `${d.code}|${d.severity}`;
      const t = tallies.get(tallyKey) ?? { code: d.code, severity: d.severity, justified: 0, falsePositive: 0, unlabelled: 0 };
      tallies.set(tallyKey, t);
      const ruleLevel = d.severity === 'info' ? labels.rules[d.code] : undefined;
      const v = labels.findings[key] ?? ruleLevel;
      if (labels.findings[key]) used.add(key);
      else if (ruleLevel) used.add(`rule:${d.code}`);
      if (!v) {
        t.unlabelled++;
        unlabelled.push(key);
      } else if (v.verdict === 'justified') {
        t.justified++;
      } else {
        t.falsePositive++;
        falsePositives.push(key);
      }
    }
  }
  const rules = [...tallies.values()].sort((a, b) => a.code.localeCompare(b.code) || a.severity.localeCompare(b.severity));
  const sum = (list: RuleTally[], k: 'justified' | 'falsePositive' | 'unlabelled') => list.reduce((n, t) => n + t[k], 0);
  const all = (list: RuleTally[]) => sum(list, 'justified') + sum(list, 'falsePositive') + sum(list, 'unlabelled');
  const we = rules.filter((t) => t.severity !== 'info');
  const unusedLabels = [...Object.keys(labels.findings).filter((k) => !used.has(k)), ...Object.keys(labels.rules).filter((k) => !used.has(`rule:${k}`)).map((k) => `rule:${k}`)];
  return {
    files: cases.length,
    findings,
    precision: ratio(sum(rules, 'justified'), all(rules)),
    precisionWarnError: ratio(sum(we, 'justified'), all(we)),
    rules,
    unlabelled,
    falsePositives,
    unusedLabels,
  };
}
