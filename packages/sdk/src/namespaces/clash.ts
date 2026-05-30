/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bim.clash - geometric clash / interference detection.
 *
 * A thin, runtime-free wrapper over the @ifc-lite/clash engine. This
 * namespace operates exclusively on caller-provided ClashElement[]: the
 * SDK never meshes geometry itself, so it stays free of the WASM /
 * geometry-pipeline runtime.
 *
 * MESHING IS THE HOST'S JOB. The CLI and MCP hosts mesh a model once
 * (via @ifc-lite/geometry's GeometryProcessor) and map the result to
 * ClashElement[] with elementsFromStep from '@ifc-lite/clash/step'. They
 * then hand those elements to these methods. The engine's rule SELECTORS
 * (IFC-type globs like 'IfcDuct*|IfcPipe*', '!IfcSpace', '*') pick which
 * element groups are tested against each other - selectors are type-based,
 * never GlobalIds.
 *
 * ```ts
 * // host meshes + builds elements, then:
 * const result = await bim.clash.matrix(elements, { mode: 'hard' });
 * const groups = bim.clash.group(result);          // BCF-ready clusters
 * console.log(result.summary.total, 'clashes');
 * ```
 */

import {
  createClashEngine,
  disciplineMatrixRules,
  groupClashes,
  CLASH_RULE_PRESETS,
  type ClashElement,
  type ClashRule,
  type ClashResult,
  type ClashGroup,
  type ClashMode,
  type ClashSettings,
  type GroupOptions,
} from '@ifc-lite/clash';

// Re-export the clash core types so SDK consumers (and the sandbox bridge)
// can describe elements / rules / results without a second direct
// dependency on @ifc-lite/clash.
export type {
  ClashElement,
  ClashElementRef,
  ClashRule,
  ClashResult,
  ClashGroup,
  Clash,
  ClashMode,
  ClashStatus,
  ClashSeverity,
} from '@ifc-lite/clash';

// ============================================================================
// Option types for the namespace API
// ============================================================================

/** How to partition a ClashResult into groups (BCF topics). */
export type ClashGroupBy = GroupOptions['by'];

/** Options accepted by `run` - forwarded to the clash engine. */
export type ClashRunOptions = ClashSettings;

/** Options accepted by `matrix` - picks the discipline preset mode plus run settings. */
export interface ClashMatrixOptions extends ClashSettings {
  /** Detection mode for the discipline-matrix preset rules. Default 'hard'. */
  mode?: ClashMode;
  /**
   * Required gap (m) applied to every matrix rule when `mode === 'clearance'`.
   * Without it a clearance matrix reports nothing (clearance is a per-rule
   * field, not a run setting), so it is threaded onto the generated rules.
   */
  clearance?: number;
}

// ============================================================================
// ClashNamespace
// ============================================================================

/**
 * bim.clash - geometric clash detection over caller-provided ClashElement[].
 *
 * Intentionally thin: it wires the @ifc-lite/clash engine, the standard
 * discipline preset rules, and the grouping/BCF helpers. Geometry meshing
 * (model bytes -> ClashElement[]) is done by the CLI / MCP hosts, not here.
 */
export class ClashNamespace {

  /**
   * Run a custom set of clash rules over the elements.
   *
   * Each rule is `{ id, name, a, b?, mode, tolerance?, clearance?, severity? }`
   * where `a`/`b` are IFC-type selectors (omit `b` for a self-clash within `a`).
   */
  run(elements: ClashElement[], rules: ClashRule[], options?: ClashRunOptions): Promise<ClashResult> {
    return createClashEngine({ backend: 'ts' }).run(elements, rules, options);
  }

  /**
   * Run the standard discipline clash matrix (MEP x STR, HVAC x ARCH, ...).
   *
   * `options.mode` selects the preset detection mode ('hard' | 'clearance');
   * remaining options are forwarded to the engine as run settings.
   */
  matrix(elements: ClashElement[], options?: ClashMatrixOptions): Promise<ClashResult> {
    // `clearance` belongs on the rules, not the run settings — pull it out so it
    // reaches disciplineMatrixRules and is not forwarded to the engine as a no-op.
    const { mode, clearance, ...settings } = options ?? {};
    return this.run(elements, disciplineMatrixRules(mode, clearance), settings);
  }

  /**
   * Group a clash result into clusters (the unit of a single BCF topic).
   * `by` defaults to 'cluster'.
   */
  group(result: ClashResult, by?: ClashGroupBy): ClashGroup[] {
    return groupClashes(result, { by: by ?? 'cluster' });
  }

  /** The built-in discipline-pair rule presets. */
  presets(): typeof CLASH_RULE_PRESETS {
    return CLASH_RULE_PRESETS;
  }

  /** The standard discipline matrix as runnable clash rules. */
  disciplineRules(mode?: ClashMode, clearance?: number): ClashRule[] {
    return disciplineMatrixRules(mode, clearance);
  }
}
