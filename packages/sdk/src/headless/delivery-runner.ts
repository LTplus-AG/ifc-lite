/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { loadModelForDelivery, runStructuralCheck, runIdsCheck, runRulesCheck, type IdsCheckResult, type RulesCheckResult, type StructuralCheckResult } from './delivery-checks.js';
import { buildDeliveryReport, type DeliveryModelEntry, type DeliveryCheckResult } from './delivery-report.js';
import type { ResolvedDeliveryRecipe } from './delivery-recipe.js';

/** Evaluate one resolved delivery recipe using the supplied model opener. */
export async function runDeliveryRecipe(
  recipe: ResolvedDeliveryRecipe,
  version: string,
  load = loadModelForDelivery,
) {
  const models: DeliveryModelEntry[] = [];
  const checks: DeliveryCheckResult[] = [];

  // Declared order throughout: models in recipe order, and within each
  // model, structural first (when requested) then every --ids file in
  // recipe order. No Map/object iteration anywhere in this loop — see
  // delivery-report.ts's determinism contract.
  for (let i = 0; i < recipe.resolvedModels.length; i++) {
    const declaredPath = recipe.models[i];
    const absPath = recipe.resolvedModels[i];
    const loaded = await load(absPath);

    if ('error' in loaded) {
      models.push({ path: declaredPath, loadError: loaded.error });
      // The model could not be loaded: every check the recipe declares for
      // it is unevaluable, and reports `error` — never silently omitted
      // (which would shrink the check count and could flip an
      // otherwise-failing recipe to a false "pass") and never `pass`.
      if (recipe.structural) {
        checks.push({
          type: 'structural', model: declaredPath, status: 'error',
          errorCount: 0, warningCount: 0, infoCount: 0, issues: [],
          error: `model ${loaded.error}`,
        } satisfies StructuralCheckResult);
      }
      for (const idsDeclared of recipe.ids) {
        checks.push({
          type: 'ids', model: declaredPath, source: idsDeclared, status: 'error',
          error: `model ${loaded.error}`,
        } satisfies IdsCheckResult);
      }
      for (const rulesDeclared of recipe.rules) {
        checks.push({
          type: 'rules', model: declaredPath, source: rulesDeclared, status: 'error',
          error: `model ${loaded.error}`,
        } satisfies RulesCheckResult);
      }
      continue;
    }

    models.push({ path: declaredPath, sha256: loaded.sha256 });

    if (recipe.structural) {
      checks.push(runStructuralCheck(declaredPath, loaded.store));
    }
    for (let j = 0; j < recipe.resolvedIds.length; j++) {
      const result = await runIdsCheck(declaredPath, loaded.store, recipe.resolvedIds[j]);
      checks.push({ ...result, source: recipe.ids[j] });
    }
    for (let j = 0; j < recipe.resolvedRules.length; j++) {
      const result = await runRulesCheck(declaredPath, loaded.store, recipe.resolvedRules[j], loaded.sourceFingerprint);
      checks.push({ ...result, source: recipe.rules[j] });
    }
  }

  return buildDeliveryReport(recipe, version, models, checks);
}
