/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rule-based Lenses as custom groupings (#8425). A Lens already is an
 * ordered list of named FilterGroup rules applied first-match, with file
 * export and legend isolation, so it is the authoring surface for a
 * classification; this turns each one into the `CustomGroupingDefinition`
 * `customGrouping` rules resolve against. Auto-colour lenses have no named
 * members and are not groupings.
 */

import type { Lens } from '@ifc-lite/lens';
import {
  resolveCapturedEntityScope, type CustomGroupingDefinition, type EvaluatorModel,
} from '@ifc-lite/rules';

/** Can `lens` be picked as a grouping? Rule-based, with at least one named rule. */
export function isGroupingLens(lens: Lens): boolean {
  return !lens.autoColor && lens.rules.some((rule) => rule.name.trim() !== '');
}

/**
 * One definition per grouping lens. A captured scope resolves against
 * `models` on first use, so a run that never reads the grouping pays nothing
 * and a missing scope source fails that run with the Lens's own message.
 */
export function customGroupingsFromLenses(
  lenses: readonly Lens[],
  models: readonly EvaluatorModel[],
): CustomGroupingDefinition[] {
  return lenses.filter(isGroupingLens).map((lens) => {
    const definition: CustomGroupingDefinition = {
      id: lens.id,
      name: lens.name,
      members: lens.rules.map((rule) => ({
        name: rule.name, enabled: rule.enabled, filter: rule.unreadableLegacy ? null : rule.groups ?? null,
      })),
    };
    const scope = lens.capturedScope;
    if (scope) {
      let resolved: Map<string, Set<number>> | undefined;
      definition.inScope = (modelId, expressId) =>
        (resolved ??= resolveCapturedEntityScope(scope, models)).get(modelId)?.has(expressId) ?? false;
    }
    return definition;
  });
}
