/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS Color System
 *
 * Pure functions that apply and clear validation result color overrides
 * on renderer meshes. No React dependencies.
 */

import type { IDSValidationReport } from '@ifc-lite/ids';
import type { GeometryResult } from '@ifc-lite/geometry';
import { toGlobalIdFromModels } from '../../store/globalId.js';

/** RGBA color tuple in 0-1 range */
export type ColorTuple = [number, number, number, number];

/** Stable default color constants */
export const DEFAULT_FAILED_COLOR: ColorTuple = [0.9, 0.2, 0.2, 1.0];
export const DEFAULT_PASSED_COLOR: ColorTuple = [0.2, 0.8, 0.2, 1.0];

/** Display options controlling which entities get color overrides */
export interface ColorDisplayOptions {
  highlightFailed: boolean;
  highlightPassed: boolean;
  failedColor: ColorTuple;
  passedColor: ColorTuple;
}

/** Model info for resolving express IDs to global IDs */
export interface ColorModelInfo {
  idOffset?: number;
}

/** Optional scoping for {@link buildValidationColorUpdates}. */
export interface ColorScopeOptions {
  /**
   * Restrict colors to a single specification's results. An entity may pass
   * one specification and fail another, so per-spec coloring (instead of the
   * whole-report verdict) is what makes the active spec's green/red correct.
   */
  specId?: string;
}

/**
 * Build a map of color overrides from validation results.
 *
 * Also captures original colors from geometry (only if originalColors is empty)
 * so they can be restored later via `buildRestoreColorUpdates`.
 *
 * @param report - The IDS validation report
 * @param models - Map of model ID to model info (for ID offset resolution)
 * @param displayOptions - Controls which highlights are active and their colors
 * @param defaultFailedColor - Fallback failed color
 * @param defaultPassedColor - Fallback passed color
 * @param geometryResult - Current geometry for capturing original colors (may be null)
 * @param originalColors - Mutable map to store original colors into (only populated if empty)
 * @param scope - Optional scoping (e.g. restrict to a single specification)
 * @returns Map of globalId to color tuple for updateMeshColors
 */
export function buildValidationColorUpdates(
  report: IDSValidationReport,
  models: ReadonlyMap<string, ColorModelInfo>,
  displayOptions: ColorDisplayOptions,
  defaultFailedColor: ColorTuple,
  defaultPassedColor: ColorTuple,
  geometryResult: GeometryResult | null | undefined,
  originalColors: Map<number, ColorTuple>,
  scope?: ColorScopeOptions
): Map<number, ColorTuple> {
  const colorUpdates = new Map<number, ColorTuple>();

  // Get color options
  const failedClr = displayOptions.failedColor ?? defaultFailedColor;
  const passedClr = displayOptions.passedColor ?? defaultPassedColor;

  // When scoped to a spec, only that spec's results drive the colors.
  const specResults = scope?.specId
    ? report.specificationResults.filter((s) => s.specification.id === scope.specId)
    : report.specificationResults;

  // Build a set of globalIds we'll be updating
  const globalIdsToUpdate = new Set<number>();
  for (const specResult of specResults) {
    for (const entityResult of specResult.entityResults) {
      const globalId = toGlobalIdFromModels(models, entityResult.modelId, entityResult.expressId);
      globalIdsToUpdate.add(globalId);
    }
  }

  // Capture original colors before applying overrides (only if not already captured)
  if (geometryResult?.meshes && originalColors.size === 0) {
    for (const mesh of geometryResult.meshes) {
      if (globalIdsToUpdate.has(mesh.expressId)) {
        originalColors.set(mesh.expressId, [...mesh.color] as ColorTuple);
      }
    }
  }

  // Process all entity results (within scope)
  for (const specResult of specResults) {
    for (const entityResult of specResult.entityResults) {
      const globalId = toGlobalIdFromModels(models, entityResult.modelId, entityResult.expressId);

      if (entityResult.passed && displayOptions.highlightPassed) {
        colorUpdates.set(globalId, passedClr);
      } else if (!entityResult.passed && displayOptions.highlightFailed) {
        colorUpdates.set(globalId, failedClr);
      }
    }
  }

  return colorUpdates;
}

/**
 * Build a map of color updates to restore original colors.
 *
 * @param originalColors - Map of globalId to original color (will be cleared after building)
 * @returns Map of globalId to original color tuple for updateMeshColors, or null if nothing to restore
 */
export function buildRestoreColorUpdates(
  originalColors: Map<number, ColorTuple>
): Map<number, ColorTuple> | null {
  if (originalColors.size === 0) {
    return null;
  }

  // Create a new map with the original colors to restore
  const colorUpdates = new Map<number, ColorTuple>(originalColors);

  // Clear the stored original colors after building restore map
  originalColors.clear();

  return colorUpdates;
}
