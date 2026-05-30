/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/clash — representation-agnostic clash detection core.
 *
 * This entry point depends only on `@ifc-lite/spatial` and geometry *types*.
 * Source adapters (STEP, IFCx) and the BCF bridge live behind subpath exports
 * (`@ifc-lite/clash/step`, …) so the core import graph stays free of
 * version-specific dependencies — the boundary that keeps IFC5 a new adapter
 * rather than a rewrite.
 */

export * from './types.js';
export { matchesSelector } from './selectors.js';
export {
  DISCIPLINES,
  CLASH_RULE_PRESETS,
  inferClashSeverity,
  disciplineMatrixRules,
  type Discipline,
  type DisciplineInfo,
  type ClashRulePreset,
} from './disciplines.js';
export { createClashEngine, type ClashEngine, type ClashBackend, type CreateClashEngineOptions } from './engine.js';
export { makeExclusionSet, isExcluded, pairKey } from './exclude.js';
export {
  buildTriageSystemPrompt,
  buildTriageUserMessage,
  parseTriageResponse,
  type ClashTriageResult,
} from './triage.js';
export { groupClashes, type GroupOptions } from './grouping.js';
export { compareClashRuns, type ClashRevisionDiff } from './lifecycle.js';
