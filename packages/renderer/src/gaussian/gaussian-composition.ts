/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How splats compose with transparent IFC (#8564, option B). With splats and
 * transparent IFC in one frame the order is: the main pass without transparent
 * IFC; splats behind the nearest transparent depth P1 (per sample); transparent
 * IFC and the selection highlight; splats in front of P1. Exact when a sample has
 * at most one transparent layer in front of opaque geometry.
 */

/** How the last splat frame composed with transparent IFC. */
export type GaussianComposition =
  /** No transparent IFC was submitted: one splat pass after the main pass, as before. Exact. */
  | 'no-transparent'
  /** A split failed while encoding; recorded draws cannot be retracted and the frame may be incomplete. */
  | 'split-failed'
  /** Splats split around the nearest transparent layer. Exact where a sample has at most one; see `transparentLayers`. */
  | 'nearest-glass-split'
  /** One splat pass over transparent IFC (approximate); `fallback` says why. */
  | 'over-transparent-approximate';

/** Why a frame with splats and transparent IFC did not complete the split. */
export type GaussianCompositionFallback =
  /** `setCompositionMode('single-pass')`. */
  | 'single-pass-mode'
  /** The split's depth-only pipelines were still compiling; a new frame is requested when they are ready. */
  | 'pipelines-compiling'
  /** A transparent draw the split cannot replay (an unregistered pipeline or an unsupported pass command). */
  | 'unsupported-draw'
  /** The installed @luma.gl/splats lacks the depth-interval hook (patches/@luma.gl__splats@9.4.2.patch). */
  | 'upstream-interval-missing'
  /** A split failed (possibly incomplete); subsequent frames keep one pass until device recovery or rebuild. */
  | 'split-failed';

/** Selects the split or the single approximate pass; the split is the default. */
export type GaussianCompositionMode = 'nearest-glass-split' | 'single-pass';

/**
 * Whether some sample of the last splat frame had two or more transparent IFC surfaces
 * in front of opaque geometry, from that frame's own GPU occlusion query: `unknown`
 * until it reads back (a later frame or a busy readback leaves it `unknown`).
 * Only zero versus non-zero is portable: some backends (Dawn on D3D12) answer occlusion
 * queries in binary, so the renderer does not report a sample count.
 * With `multiple`, splats lying between those surfaces are approximate. A closed
 * glass solid has two surfaces.
 */
export type GaussianTransparentLayers = 'single' | 'multiple' | 'unknown';

export interface GaussianCompositionReport {
  readonly composition: GaussianComposition;
  readonly fallback: GaussianCompositionFallback | null;
  /** Split frames only; null otherwise. */
  readonly transparentLayers: GaussianTransparentLayers | null;
  /**
   * Split frames only: the selection highlight drew. It keeps its rule of drawing
   * over transparent IFC, so it also covers splats behind the nearest transparent
   * layer on the highlighted surface; splats in front of that layer stay on top.
   */
  readonly highlightOverSplats: boolean;
  /**
   * Split frames only: points, reference images or overlays drew. They keep their place
   * after transparent IFC, so they draw after the splats behind the nearest transparent
   * layer and cover those splats where they lie behind them; splats in front of that
   * layer still draw over them, as before.
   */
  readonly laterOverBehindSplats: boolean;
}

export const NO_TRANSPARENT: GaussianCompositionReport = Object.freeze({
  composition: 'no-transparent', fallback: null, transparentLayers: null, highlightOverSplats: false, laterOverBehindSplats: false,
});

/** The report of one frame from what the recorder saw and why it did or did not split. */
export function compositionReport(
  frame: { incomplete?: boolean; transparent: boolean; split: boolean; highlight: boolean; later: boolean; fallback: GaussianCompositionFallback | null },
  layers: GaussianTransparentLayers,
): GaussianCompositionReport {
  if (!frame.transparent) return NO_TRANSPARENT;
  if (frame.incomplete) {
    return Object.freeze({ composition: 'split-failed', fallback: 'split-failed', transparentLayers: null, highlightOverSplats: false, laterOverBehindSplats: false });
  }
  if (!frame.split) {
    return Object.freeze({ composition: 'over-transparent-approximate', fallback: frame.fallback ?? 'unsupported-draw', transparentLayers: null, highlightOverSplats: false, laterOverBehindSplats: false });
  }
  return Object.freeze({ composition: 'nearest-glass-split', fallback: null, transparentLayers: layers, highlightOverSplats: frame.highlight, laterOverBehindSplats: frame.later });
}
