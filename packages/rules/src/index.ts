/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@ifc-lite/rules` — the filter-rule vocabulary, the Path-B evaluator, and
 * the `.rules.json` information-validation engine (#5138 PR 7a). Extracted
 * from `apps/viewer/src/lib/{search,validation}` so `packages/cli` (PR 7b)
 * can run the SAME evaluator the viewer runs — no second implementation,
 * no parity fixture between "what the viewer says" and "what the CLI says".
 *
 * No React, no store, no DOM: every export here takes plain data in
 * (`IfcDataStore`, `EvaluatorModel[]`) and returns plain data out. The
 * viewer's `lib/model-tags/evaluator-models.ts` (turns live store state into
 * `EvaluatorModel[]`) and `lib/validation/rule-set-io-browser.ts`
 * (`exportRuleSet`/`importRuleSetFile`, DOM file I/O) stay in the viewer —
 * not this package's concern.
 */

// ── Filter-rule vocabulary + evaluator ──────────────────────────────────────
export * from './filter/filter-rules.js';
export * from './filter/filter-groups.js';
export { MODEL_FACTS, type ModelFact } from './filter/filter-model-fact.js';
export * from './filter/filter-rule-guards.js';
export * from './filter/filter-ops.js';
export * from './filter/legacy-operator-adapters.js';
export * from './filter/filter-match.js';
export * from './filter/read-subject.js';
export * from './filter/filter-evaluate.js';
export * from './filter/filter-evaluate-groups.js';
export * from './filter/filter-evaluate-yield.js';
export * from './filter/filter-evaluate-mutations.js';
export * from './filter/filter-evaluate-model-tag.js';
export * from './filter/filter-iteration.js';
export * from './filter/filter-iteration-source.js';
export * from './filter/entity-predefined-type.js';
export * from './filter/lens-material-names.js';
export * from './filter/model-tag.js';

// ── `.rules.json` shape + parse/serialize (Node/browser-portable half) ─────
export * from './rule-set/rule-set.js';
export * from './rule-set/rule-set-io.js';
export * from './rule-set/rule-set-io-requirement.js';
export * from './rule-set/requirement-text.js';
export * from './rule-set/between-chip.js';

// ── Validation engine: RuleSetFile + models -> ValidationReport ────────────
export * from './engine/rule-engine.js';

// ── IDS interchange: rule set -> IDS 1.0 export, simple IDS -> rule import (#5225)
export { ruleSetToIds, type RuleSetToIdsOptions, type RuleSetToIdsResult, type RefusedRule } from './ids/rule-set-to-ids.js';
export { idsToRuleSet, type IdsToRuleSetOptions, type IdsToRuleSetResult, type RefusedSpecification } from './ids/ids-to-rule-set.js';
