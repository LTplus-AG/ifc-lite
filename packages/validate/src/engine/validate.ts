/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Model } from '../runtime/model.js';
import type { FindingCategory, ValidationFinding, ValidationReport } from './findings.js';
import { checkHeader } from './header.js';
import { checkInstance, type InstanceCheckCounters } from './instance-checks.js';
import { checkEntityRules, checkGlobalIds, checkGlobalRules, checkUniqueRules } from './population-checks.js';

export interface ValidateOptions {
  /** Finding categories to produce; all by default. `simpletype_rule` runs with `schema`. */
  categories?: FindingCategory[];
  /** STEP text, for the HEADER checks. */
  headerText?: string;
  /** Restrict entity WHERE rules to instances of these entities (and subtypes). */
  entities?: string[];
}

const now = (): number => Date.now();

export function validateModel(m: Model, options: ValidateOptions = {}): ValidationReport {
  const started = now();
  const wants = (c: FindingCategory) => !options.categories || options.categories.includes(c);
  const findings: ValidationFinding[] = [];
  const counters: InstanceCheckCounters = { typeRuleEvaluations: 0 };
  if (options.headerText !== undefined && wants('header')) checkHeader(options.headerText, findings);
  const evaluateErrors = wants('evaluation_error');
  if (wants('schema') || wants('simpletype_rule') || evaluateErrors) {
    for (const message of m.syntaxErrors) findings.push({ category: 'schema', rule: 'record-syntax', message });
    for (const id of m.duplicateIds) findings.push({ category: 'schema', rule: 'duplicate-id', instance: id, message: `Duplicate STEP instance #${id}` });
    for (const id of m.ids()) checkInstance(m, id, findings, counters);
    checkGlobalIds(m, findings);
  }
  const filter = options.entities?.map((e) => m.schema.entity(e)?.upper).filter((e): e is string => !!e);
  const include = filter ? (name: string) => filter.some((f) => m.schema.entity(name)?.isA(f) ?? false) : undefined;
  const entityRuleEvaluations = (wants('entity_rule') || evaluateErrors) ? checkEntityRules(m, findings, include) : 0;
  if (wants('unique_rule')) checkUniqueRules(m, findings);
  if (wants('global_rule') || evaluateErrors) checkGlobalRules(m, findings);
  const kept = findings.filter((f) => f.category === 'evaluation_error' || wants(f.category));
  return {
    schema: m.schema.name,
    valid: kept.length === 0,
    findings: kept,
    notEvaluated: m.schema.rules.unsupported.map((u) => ({ scope: u.scope, owner: u.owner, label: u.label, reason: u.reason })),
    stats: {
      instances: m.ids().length,
      entityRuleEvaluations,
      typeRuleEvaluations: counters.typeRuleEvaluations,
      milliseconds: Math.round(now() - started),
    },
  };
}
