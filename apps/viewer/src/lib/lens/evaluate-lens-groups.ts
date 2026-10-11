/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Resolve each manual Lens rule through the one shared federated filter
 * evaluator (#5896). The Lens engine then applies first-match actions to the
 * returned global-ID sets; selection semantics stay in @ifc-lite/rules. */
import type { Lens } from '@ifc-lite/lens';
import { evaluateFilterGroupsFederated, resolveCapturedEntityScope, type EvaluatorModel } from '@ifc-lite/rules';
import { toGlobalIdFromModels, type ForwardModelMapLike } from '@/store/globalId';

export async function evaluateLensGroups(
  lens: Lens,
  evaluatorModels: ReadonlyArray<EvaluatorModel>,
  models: ForwardModelMapLike,
  definedModelTagIds: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<Map<string, Set<number>>> {
  const matched = new Map<string, Set<number>>();
  const candidates = lens.capturedScope ? resolveCapturedEntityScope(lens.capturedScope, evaluatorModels) : undefined;
  for (const rule of lens.rules) {
    if (!rule.enabled || rule.unreadableLegacy || !rule.groups?.length) continue;
    if (signal?.aborted) throw new DOMException('Lens evaluation aborted', 'AbortError');
    const rows = await evaluateFilterGroupsFederated(evaluatorModels, rule.groups, {
      limit: Number.POSITIVE_INFINITY, signal, definedModelTagIds, candidateExpressIdsByModel: candidates,
    });
    matched.set(rule.id, new Set(rows.map(({ modelId, expressId }) =>
      toGlobalIdFromModels(models, modelId, expressId))));
  }
  return matched;
}
