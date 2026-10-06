/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The rule content a rule-set ("information") validation report was run
 * from (#6921). The native report's `source.ruleSet` names the file only, so
 * two runs of a rule edited under the same name and stable rule id would be
 * indistinguishable. The runner records the content here, keyed by the
 * report object (as `stampAnalysisReport` keys run stamps), so a consumer
 * that must know whether two runs checked the same rules can ask.
 */

import type { RuleSetFile } from '@ifc-lite/rules';

export interface ReportRuleSetContent {
  /** The whole file serialised at run time: name, targets and every rule. */
  file: string;
  /** Each rule serialised, by rule id (the report's specification id). */
  rules: ReadonlyMap<string, string>;
}

const contents = new WeakMap<object, ReportRuleSetContent>();

/** Serialise a rule set before a run starts, so a later edit cannot leak into the record. */
export function ruleSetContentOf(ruleSet: RuleSetFile): ReportRuleSetContent {
  return { file: JSON.stringify(ruleSet), rules: new Map(ruleSet.rules.map(rule => [rule.id, JSON.stringify(rule)])) };
}

export function recordReportRuleSet<T extends object>(report: T, content: ReportRuleSetContent): T {
  contents.set(report, content);
  return report;
}

/** The recorded rule content of a report; null when the report was not produced by the runner. */
export function reportRuleSetOf(report: object): ReportRuleSetContent | null {
  return contents.get(report) ?? null;
}
