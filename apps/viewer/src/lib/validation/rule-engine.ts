/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rule-engine orchestration (#5138 PR 3, plan §4): the ONE entry point,
 * `runRuleSet`, that turns a `RuleSetFile` plus the loaded models into a
 * `ValidationReport`. Per rule: resolve applicability (§4.1, `exactClass`
 * §4 item 1 last sentence), check cardinality (§4 item 8), dispatch to the
 * `element` (`rule-engine-requirements.ts`), `unique` / `aggregate` /
 * `compare` (`rule-engine-sets.ts`) checker, then fold into one
 * `SpecificationResult`. Async chunked (`yieldToEventLoop`), cancellable
 * (`AbortSignal` → rejects with `AbortError`; no partial report is ever
 * returned — the report object is only built after every rule finishes).
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { exactTypeName } from '@ifc-lite/data';
import {
  calculateSummary,
  type EntityResult,
  type IDSCardinalityResult,
  type SpecificationResult,
  type ValidationModelInfo,
  type ValidationReport,
} from '@ifc-lite/ids';

import type { IfcTypeRule } from '../search/filter-rules.js';
import { setOpMatches } from '../search/filter-ops.js';
import { evaluateFilterGroupsFederated } from '../search/filter-evaluate-groups.js';
import type { EvaluatorModel, FilteredElement } from '../search/filter-evaluate.js';
import { throwAbort } from '../search/filter-evaluate-yield.js';
import { evaluatorModelsFromState, type ModelTagState } from '../model-tags/evaluator-models.js';

import type { InformationRule, RuleBlock, RuleSetFile, RuleSetTargets } from './rule-set.js';
import { checkElementForEntity, type ValidationOpts } from './rule-engine-requirements.js';
import { checkAggregate, checkUnique, type SetCheckOutcome } from './rule-engine-sets.js';
import { checkCompare } from './rule-engine-compare.js';
import { maybeYieldChunk, finalProgress, type RuleEngineProgress } from './rule-engine-chunk.js';

export type { RuleEngineProgress };

export interface RunRuleSetOptions {
  ruleSet: RuleSetFile;
  /** Every currently-loaded model, tags and live edits — the one input
   *  `evaluatorModelsFromState` needs (plan: "targets → EvaluatorModel list
   *  via lib/model-tags/evaluator-models.ts"). */
  models: ModelTagState;
  signal?: AbortSignal;
  onProgress?: (progress: RuleEngineProgress) => void;
}

/** `targets` narrows the loaded-model list to the rule set's declared
 *  default targets (plan §3: never a local model id; both lists OR'd;
 *  empty/absent = every loaded model). */
export function resolveTargetModels(state: ModelTagState, targets: RuleSetTargets | undefined): EvaluatorModel[] {
  const all = evaluatorModelsFromState(state);
  const fingerprints = targets?.modelFingerprints ?? [];
  const tagIds = targets?.modelTagIds ?? [];
  if (fingerprints.length === 0 && tagIds.length === 0) return all;
  const fpSet = new Set(fingerprints);
  const tagSet = new Set(tagIds);
  return all.filter((m) => {
    if (fpSet.size > 0 && m.filterIdentity !== undefined && fpSet.has(m.filterIdentity)) return true;
    if (tagSet.size > 0 && m.tagIds) for (const t of m.tagIds) if (tagSet.has(t)) return true;
    return false;
  });
}

function buildModelInfo(models: readonly EvaluatorModel[]): ValidationModelInfo[] {
  const out: ValidationModelInfo[] = [];
  for (const m of models) {
    if (!m.store) continue;
    out.push({
      modelId: m.id,
      schemaVersion: m.store.schemaVersion || 'IFC4',
      entityCount: m.store.entityCount || m.store.entities.count,
    });
  }
  return out;
}

/** Every `exactClass`-flagged `ifcType` rule in an applicability block (plan
 *  §2 row "Class inheritance", §4 item 1 last sentence). Scoped to the WHOLE
 *  block rather than per-`FilterGroup` — a rule authoring `exactClass` on one
 *  OR-branch and not another is not a shape the editor (PR 5) offers, so a
 *  whole-rule post-filter is the closest correct reading, not a narrowing of
 *  an actually-supported shape (documented here per the brief's "closest
 *  correct thing" instruction rather than left unhandled). */
function exactClassRulesOf(block: RuleBlock): IfcTypeRule[] {
  const out: IfcTypeRule[] = [];
  for (const group of block.groups) {
    for (const rule of group.rules) {
      if (rule.kind === 'ifcType' && rule.exactClass) out.push(rule);
    }
  }
  return out;
}

function applyExactClassFilter(
  elements: readonly FilteredElement[],
  rules: readonly IfcTypeRule[],
  storesById: ReadonlyMap<string, IfcDataStore>,
  opts: ValidationOpts,
): FilteredElement[] {
  if (rules.length === 0) return [...elements];
  return elements.filter((el) => {
    const store = storesById.get(el.modelId);
    if (!store) return false;
    const exact = exactTypeName(store.entities, el.expressId);
    return rules.some((r) => setOpMatches(r.op, exact, r.values, opts));
  });
}

function checkCardinality(
  cardinality: InformationRule['cardinality'],
  count: number,
): IDSCardinalityResult | undefined {
  if (!cardinality || (cardinality.minApplicable === undefined && cardinality.maxApplicable === undefined)) {
    return undefined;
  }
  const messages: string[] = [];
  let passed = true;
  if (cardinality.minApplicable !== undefined && count < cardinality.minApplicable) {
    passed = false;
    messages.push(`expected at least ${cardinality.minApplicable}, found ${count}`);
  }
  if (cardinality.maxApplicable !== undefined && count > cardinality.maxApplicable) {
    passed = false;
    messages.push(`expected at most ${cardinality.maxApplicable}, found ${count}`);
  }
  return {
    passed,
    actualCount: count,
    minExpected: cardinality.minApplicable,
    maxExpected: cardinality.maxApplicable,
    message: messages.length > 0 ? messages.join('; ') : 'Cardinality satisfied',
  };
}

async function runElementRequirement(
  ruleId: string,
  block: RuleBlock,
  applicable: readonly FilteredElement[],
  storesById: ReadonlyMap<string, IfcDataStore>,
  opts: ValidationOpts,
  ruleIndex: number,
  signal: AbortSignal | undefined,
  onProgress: ((p: RuleEngineProgress) => void) | undefined,
): Promise<EntityResult[]> {
  const out: EntityResult[] = [];
  for (let i = 0; i < applicable.length; i++) {
    const el = applicable[i];
    const store = storesById.get(el.modelId);
    if (store) out.push(checkElementForEntity(ruleId, block, el, store, opts));
    await maybeYieldChunk(i + 1, applicable.length, ruleIndex, signal, onProgress);
  }
  finalProgress(applicable.length, ruleIndex, signal, onProgress);
  return out;
}

function finalizeSpecification(
  rule: InformationRule,
  applicableCount: number,
  cardinalityResult: IDSCardinalityResult | undefined,
  outcome: SetCheckOutcome,
  error?: string,
): SpecificationResult {
  const specification = { id: rule.id, name: rule.name, description: rule.description };
  if (error !== undefined) {
    // Existing IDS convention (`packages/ids/src/report-types.ts`'s
    // `SpecificationResult.error` doc): an unevaluable rule is `status:
    // 'fail'` with `error` set, never silently folded into `pass`.
    return {
      specification, status: 'fail', applicableCount, passedCount: 0, failedCount: 0, passRate: 0,
      entityResults: [], error,
    };
  }

  const failedEntities = outcome.entityResults.filter((e) => !e.passed).length;
  const passedEntities = outcome.entityResults.filter((e) => e.passed).length;
  const setsFail = (outcome.setResults ?? []).some((s) => !s.passed);

  // `element`/`compare` report every applicable entity (pass and fail), so
  // their counts read straight off `entityResults`. `unique`/`aggregate`
  // only ever construct FAILING rows (plan §4.5/§4.6 — a whole federation's
  // worth of passing rows would dwarf the report for no reporting value),
  // so their `passedCount` is the complement against `applicableCount`.
  const isPerElementKind = rule.requirement.kind === 'element' || rule.requirement.kind === 'compare';
  const passedCount = isPerElementKind ? passedEntities : Math.max(0, applicableCount - failedEntities);
  const failedCount = failedEntities;

  const anyFail = failedEntities > 0 || setsFail || cardinalityResult?.passed === false;
  const status: SpecificationResult['status'] = applicableCount === 0
    ? (cardinalityResult?.passed === false ? 'fail' : cardinalityResult?.passed === true ? 'pass' : 'not_applicable')
    : (anyFail ? 'fail' : 'pass');
  const passRate = applicableCount > 0 ? Math.floor((passedCount / applicableCount) * 100) : 100;

  return {
    specification, status, applicableCount, passedCount, failedCount, passRate,
    entityResults: outcome.entityResults,
    cardinalityResult,
    setResults: outcome.setResults,
    setResultsTruncated: outcome.setResultsTruncated,
  };
}

/** Run every rule in `ruleSet` against the targeted models and return one
 *  `ValidationReport`. Rejects with `AbortError` on cancellation; the report
 *  object is constructed only after the loop completes, so a caller can
 *  never observe a partial one. */
export async function runRuleSet(options: RunRuleSetOptions): Promise<ValidationReport> {
  const { ruleSet, models: state, signal, onProgress } = options;
  const targetModels = resolveTargetModels(state, ruleSet.targets);
  const storesById = new Map<string, IfcDataStore>();
  for (const m of targetModels) if (m.store) storesById.set(m.id, m.store);
  const modelInfo = buildModelInfo(targetModels);

  const specificationResults: SpecificationResult[] = [];
  for (let ruleIndex = 0; ruleIndex < ruleSet.rules.length; ruleIndex++) {
    if (signal?.aborted) throwAbort(signal);
    const rule = ruleSet.rules[ruleIndex];
    const opts: ValidationOpts = { caseSensitive: rule.caseSensitive ?? true, tolerance: rule.tolerance ?? 1e-6 };
    // Tracked outside the `try` so the `catch` can report the REAL applicable
    // count when applicability itself succeeded and only the requirement
    // check threw — `0` is reserved for when applicability never resolved.
    let applicableCount = 0;

    try {
      const applicableRaw = await evaluateFilterGroupsFederated(targetModels, rule.applicability.groups, {
        limit: Number.MAX_SAFE_INTEGER,
        signal,
        onProgress: (done, total) => onProgress?.({ ruleIndex, phase: 'applicability', done, total }),
      });
      const applicable = applyExactClassFilter(applicableRaw, exactClassRulesOf(rule.applicability), storesById, opts);
      applicableCount = applicable.length;
      const cardinalityResult = checkCardinality(rule.cardinality, applicableCount);

      let outcome: SetCheckOutcome;
      switch (rule.requirement.kind) {
        case 'element': {
          const entityResults = await runElementRequirement(
            rule.id, rule.requirement.block, applicable, storesById, opts, ruleIndex, signal, onProgress,
          );
          outcome = { entityResults };
          break;
        }
        case 'unique':
          outcome = await checkUnique(rule.id, rule.requirement, applicable, storesById, opts, ruleIndex, signal, onProgress);
          break;
        case 'aggregate':
          outcome = await checkAggregate(rule.id, rule.requirement, applicable, storesById, targetModels, opts, ruleIndex, signal, onProgress);
          break;
        case 'compare':
          outcome = await checkCompare(rule.id, rule.requirement, applicable, storesById, opts, ruleIndex, signal, onProgress);
          break;
      }

      specificationResults.push(finalizeSpecification(rule, applicableCount, cardinalityResult, outcome));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      const message = err instanceof Error ? err.message : String(err);
      specificationResults.push(finalizeSpecification(rule, applicableCount, undefined, { entityResults: [] }, message));
    }
  }

  return {
    source: { kind: 'rules', ruleSet: { name: ruleSet.name, description: ruleSet.description } },
    modelInfo,
    timestamp: new Date(),
    summary: calculateSummary(specificationResults),
    specificationResults,
  };
}
