/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS Color System
 *
 * Pure functions that build validation result colour overrides. No React
 * dependencies.
 */

import type { ValidationReport } from '@ifc-lite/ids';
import { toGlobalIdFromModels } from '../../store/globalId.js';

/** RGBA color tuple in 0-1 range */
export type ColorTuple = [number, number, number, number];

/** Stable default color constants */
export const DEFAULT_FAILED_COLOR: ColorTuple = [0.9, 0.2, 0.2, 1.0];
export const DEFAULT_PASSED_COLOR: ColorTuple = [0.2, 0.8, 0.2, 1.0];

/**
 * The colour the ROW the user just activated is painted, on top of the report
 * overlay (#2867).
 *
 * The reported problem is that an activated element cannot be found: it keeps
 * the report red (failed) or green (passed), so it looks exactly like every
 * other failing element around it. A third, distinct hue is what separates
 * "the one I clicked" from "the ones near it", and it has to be far from BOTH
 * report colours to do that — hence cyan rather than a lighter red.
 *
 * Pushed through the colour-override channel (the albedo path the lens and the
 * clash pair tint use), not the selection outline, so it survives batched and
 * GPU-instanced geometry and shows in all three focus modes.
 */
export const IDS_FOCUS_COLOR: ColorTuple = [0.0, 0.75, 1.0, 1.0];

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
 * The result is an OVERLAY for the colour-override channel
 * (`pendingColorUpdates`): it never touches the model's own colours, so
 * dropping the overlay is all "restore original colours" needs (#6373, see
 * `lib/ids/color-ownership.ts`).
 *
 * @param report - The validation report (IDS or rule-set)
 * @param models - Map of model ID to model info (for ID offset resolution)
 * @param displayOptions - Controls which highlights are active and their colors
 * @param defaultFailedColor - Fallback failed color
 * @param defaultPassedColor - Fallback passed color
 * @param scope - Optional scoping (e.g. restrict to a single specification)
 * @returns Map of globalId to color tuple
 */
export function buildValidationColorUpdates(
  report: ValidationReport,
  models: ReadonlyMap<string, ColorModelInfo>,
  displayOptions: ColorDisplayOptions,
  defaultFailedColor: ColorTuple,
  defaultPassedColor: ColorTuple,
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
