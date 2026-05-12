/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Graphic Overrides Module
 *
 * Provides parametric styling for 2D architectural drawings based on
 * element properties, IFC types, and user-defined criteria.
 */

// Types
export type {
  LineWeightPreset,
  LineStylePreset,
  DashPattern,
  CriteriaOperator,
  CriteriaType,
  OverrideCriterion,
  OverrideCriteria,
  GraphicStyle,
  GraphicOverrideRule,
  GraphicOverridePreset,
  ElementData,
  ResolvedGraphicStyle,
  OverrideResult,
} from './types.js';

// Rule Engine
export {
  GraphicOverrideEngine,
  createOverrideEngine,
  ifcTypeCriterion,
  propertyCriterion,
  andCriteria,
  orCriteria,
} from './rule-engine.js';

// Presets
export {
  BUILT_IN_PRESETS,
  VIEW_3D_PRESET,
  ARCHITECTURAL_PRESET,
  FIRE_SAFETY_PRESET,
  STRUCTURAL_PRESET,
  MEP_PRESET,
  MONOCHROME_PRESET,
  getBuiltInPreset,
  getPresetsByCategory,
} from './presets.js';
