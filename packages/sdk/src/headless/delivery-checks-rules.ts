/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `.rules.json` check evaluation for `ifc-lite delivery`'s `rules` field —
 * split out of `delivery-checks.ts` (module-size ratchet: adding this
 * pushed that file over 400 lines).
 */

import { readFile } from 'node:fs/promises';
import type { IfcDataStore } from '@ifc-lite/parser';
import { parseRuleSetFile, runRuleSet, type EvaluatorModel } from '@ifc-lite/rules';
import type { CheckStatus } from './delivery-checks.js';

export interface RulesCheckResult {
  type: 'rules';
  model: string;
  source: string;
  status: CheckStatus;
  totalRules?: number;
  passedRules?: number;
  failedRules?: number;
  erroredRules?: number;
  error?: string;
}

/**
 * Run one `.rules.json` information-validation rule set (`@ifc-lite/rules`,
 * #5138 PR 7b — the SAME engine `ifc-lite check` and the viewer's Data
 * Validation panel run) against one already-loaded model.
 *
 * `status` is `error` when the rules file itself could not be
 * read/parsed/validated, when it declares zero rules (nothing was actually
 * evaluated), or when ANY rule's `SpecificationResult.error` is set (the
 * engine could not evaluate it — e.g. a ReDoS-rejected regex). An
 * unevaluable rule is never silently folded into `pass`. Otherwise `fail`
 * iff at least one rule's `status` is `'fail'`.
 *
 * Each recipe's `rules` file runs against ONE model at a time here,
 * matching the per-model loop `ifc-lite delivery` already uses for `ids` —
 * a rule federated across every recipe model (`targets`, `unique` scope
 * `'federation'`) is `ifc-lite check`'s job: run directly against every
 * declared model file in one invocation, not `delivery`'s per-model shape.
 *
 * `sourceFingerprint` is `LoadedModel.sourceFingerprint` (#5138 PR 7b
 * review) — passed through as `filterIdentity` so a rule with `targets`
 * resolves against this model exactly as the viewer would.
 */
export async function runRulesCheck(modelPath: string, store: IfcDataStore, rulesPath: string, sourceFingerprint: string): Promise<RulesCheckResult> {
  const base = { type: 'rules' as const, model: modelPath, source: rulesPath };

  let rulesContent: string;
  try {
    rulesContent = await readFile(rulesPath, 'utf-8');
  } catch (err) {
    return { ...base, status: 'error', error: `could not be read: ${(err as Error).message}` };
  }

  let rulesJson: unknown;
  try {
    rulesJson = JSON.parse(rulesContent);
  } catch (err) {
    return { ...base, status: 'error', error: `is not valid JSON: ${(err as Error).message}` };
  }

  const parsed = parseRuleSetFile(rulesJson);
  if (!parsed.ok) {
    return { ...base, status: 'error', error: parsed.error };
  }
  if (parsed.file.rules.length === 0) {
    return { ...base, status: 'error', error: 'declares zero rules' };
  }

  const evaluatorModel: EvaluatorModel = { id: modelPath, filterIdentity: sourceFingerprint, store };
  let report;
  try {
    report = await runRuleSet({ ruleSet: parsed.file, models: [evaluatorModel] });
  } catch (err) {
    return { ...base, status: 'error', error: `evaluation failed: ${(err as Error).message}` };
  }

  const totalRules = report.specificationResults.length;
  const erroredRules = report.specificationResults.filter(r => r.error !== undefined).length;
  const failedRules = report.specificationResults.filter(r => r.error === undefined && r.status === 'fail').length;
  const passedRules = totalRules - erroredRules - failedRules;
  const status: CheckStatus = erroredRules > 0 ? 'error' : failedRules > 0 ? 'fail' : 'pass';

  return {
    ...base,
    status,
    totalRules, passedRules, failedRules, erroredRules,
    ...(status === 'error' && erroredRules > 0 ? { error: `${erroredRules} of ${totalRules} rule(s) could not be evaluated` } : {}),
  };
}
