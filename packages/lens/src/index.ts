/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/lens — Rule-based 3D filtering and colorization
 *
 * Pure, framework-agnostic lens evaluation engine for IFC models.
 * Evaluate rules that match entities by IFC class, property value, or
 * material name and apply visual actions (colorize, hide, transparent).
 *
 * @example
 * ```ts
 * import { evaluateLens, BUILTIN_LENSES } from '@ifc-lite/lens';
 * import type { LensDataProvider } from '@ifc-lite/lens';
 *
 * const provider: LensDataProvider = createMyProvider(myData);
 * const result = evaluateLens(BUILTIN_LENSES[0], provider);
 * // result.colorMap  — Map<globalId, RGBAColor>
 * // result.hiddenIds — Set<globalId>
 * // result.ruleCounts — Map<ruleId, count>
 * ```
 */

// ============================================================================
// Types
// ============================================================================

export type {
  LensDataProvider,
  PropertySetInfo,
  ClassificationInfo,
  LensCriteria,
  LensOperator,
  LensRule,
  Lens,
  AutoColorSpec,
  AutoColorLegendEntry,
  LensEvaluationResult,
  RGBAColor,
} from './types.js';

export {
  COMMON_IFC_CLASSES,
  /** @deprecated Use COMMON_IFC_CLASSES instead */
  COMMON_IFC_CLASSES as COMMON_IFC_TYPES,
  LENS_PALETTE,
  IFC_SUBTYPE_TO_BASE,
  LENS_CRITERIA_TYPES,
  LENS_OPERATORS,
  AUTO_COLOR_SOURCES,
  ENTITY_ATTRIBUTE_NAMES,
} from './types.js';

// ============================================================================
// Engine
// ============================================================================

export { evaluateLens, evaluateAutoColorLens } from './engine.js';
export type { AutoColorEvaluationResult } from './engine.js';

// ============================================================================
// Matching
// ============================================================================

export { matchesCriteria } from './matching.js';

// ============================================================================
// Colors
// ============================================================================

export {
  GHOST_COLOR,
  hexToRgba,
  rgbaToHex,
  isGhostColor,
  uniqueColor,
} from './colors.js';

// ============================================================================
// Presets
// ============================================================================

export { BUILTIN_LENSES } from './presets.js';

// ============================================================================
// Discovery
// ============================================================================

export { discoverClasses, discoverDataSources } from './discovery.js';
export type { DiscoveredLensData } from './discovery.js';
