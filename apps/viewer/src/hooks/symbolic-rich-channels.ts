/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pure merge step behind `useSymbolicAnnotationsRichData` — the text and
 * fill twin of `symbolic-line-channels.ts`, split out for the same reason and
 * along the same seam #3381 cut: it takes already-resolved `ParseResult`s and
 * scalars, so a call runs against a hand-built parse with no React tree, no
 * store subscription, no overlay worker and no parse-cache lookup.
 *
 * Purity of the CALL, not of the import graph: `resolveBucketY` is imported
 * from the hook file (as the line twin does), so loading this module still
 * loads React, the store and `symbolic-parse-cache.ts`. Nothing here reads
 * them, which is the property the tests below rely on.
 *
 * That seam is what makes the grid section-clip band (issue #862) testable.
 * While this walk lived inside the hook, the only way to reach its band check
 * was to mount React over a stubbed worker and the shared parse cache — and an
 * attempt to do exactly that produced in-band / out-of-band cases that stayed
 * green with BOTH band checks deleted: the parse cache is keyed on the
 * source's `contentKey`, not on which fixture the stubbed worker holds, so the
 * second parse of a test reused the first one's NaN-world-Y result, every grid
 * primitive sat in `gridLoose*`, and the band check iterated an empty
 * `gridByStorey` (issue #3393). `symbolic-grid-section-clip.test.ts` holds the
 * measurement and the fixture that does reach the buckets.
 */

import type {
  AnnotationFill2D,
  AnnotationText2D,
  ParseResult,
} from '../lib/overlay-parse/symbolic-parse.js';
import { resolveBucketY } from './useSymbolicAnnotations.js';

/**
 * A text annotation lifted into 3D world space.
 *
 * `worldPos[1]` is the storey Y the annotation belongs to (or `fallbackY` for
 * orphans). `dirX / dirZ` is the baseline direction in 3D (already mirrored
 * from the IFC frame to match the section overlay's coordinate handedness).
 * `height` is in world units.
 */
export interface AnnotationText3D {
  worldPos: [number, number, number];
  dirX: number;
  dirZ: number;
  height: number;
  content: string;
  alignment: string;
  /** True when the glyph quad should rebuild in camera-aligned basis (grid tags). */
  billboard?: boolean;
  /** sRGB straight-alpha tint, 0..1. */
  color?: [number, number, number, number];
  /** Per-instance target cap height in screen pixels. */
  targetPx?: number;
  /**
   * False for grid bubbles: drawn, but the scene AABB must not grow to them
   * (#3359). REQUIRED here, unlike the optional on the renderer's published
   * `SymbolicTextInput`: this module is the only producer and every push sets
   * it, so requiring it makes the forwarding compiler-checked rather than
   * remembered. The published side stays optional, which is what keeps the
   * field an additive change for outside callers.
   */
  definesExtent: boolean;
}

/**
 * A filled region lifted into 3D world space. `points` is a flat
 * `[x, z, x, z, …]` ring buffer (Y is constant = `worldY`). Holes are tracked
 * via `holesOffsets` (vertex indices into `points`); the renderer triangulates.
 */
export interface AnnotationFill3D {
  points: Float32Array;
  holesOffsets: Uint32Array;
  worldY: number;
  color: [number, number, number, number];
  hatching?: AnnotationFill2D['hatching'];
  /** False for grid bubble fills. See [`AnnotationText3D.definesExtent`] (#3359). */
  definesExtent: boolean;
}

export interface SymbolicRichChannels {
  texts: readonly AnnotationText3D[];
  fills: readonly AnnotationFill3D[];
}

/** One store's parsed buckets + hide predicate — no React/WASM dependency,
 *  so `buildSymbolicRichChannels` runs against a hand-built `ParseResult`
 *  in a test. */
export interface SymbolicRichChannelsEntry {
  cached: ParseResult;
  isHidden?: (ownerId: number) => boolean;
}

interface SymbolicRichChannelsParams {
  enabled: boolean;
  effectiveGridEnabled: boolean;
  clipEnabled: boolean;
  clipPos: number;
  clipDepth: number;
  fallbackY: number;
}

/** Cheap stable empty arrays for the no-data path. */
const EMPTY_TEXTS: readonly AnnotationText3D[] = Object.freeze([]);
const EMPTY_FILLS: readonly AnnotationFill3D[] = Object.freeze([]);

/** The "both toggles off" result. One shared frozen value so the hook's own
 *  early return and this module's cannot drift into two different shapes. */
export const EMPTY_RICH_CHANNELS: SymbolicRichChannels = Object.freeze({
  texts: EMPTY_TEXTS,
  fills: EMPTY_FILLS,
});

/** Pure merge of every store's annotation and grid texts/fills into two flat
 *  3D-lifted lists. Exported for unit testing. */
export function buildSymbolicRichChannels(
  entries: readonly SymbolicRichChannelsEntry[],
  params: SymbolicRichChannelsParams,
): SymbolicRichChannels {
  const { enabled, effectiveGridEnabled, clipEnabled, clipPos, clipDepth, fallbackY } = params;
  if (!enabled && !effectiveGridEnabled) return EMPTY_RICH_CHANNELS;

  const texts: AnnotationText3D[] = [];
  const fills: AnnotationFill3D[] = [];

  for (const { cached, isHidden } of entries) {
    // `definesExtent`: see [`AnnotationText3D.definesExtent`] for why the
    // channel routing does not reach bubbles (#3359).
    const pushText = (t: AnnotationText2D, y: number, definesExtent: boolean) => {
      if (isHidden && isHidden(t.ownerId)) return;
      // lineYOffset stacks multi-line text downward in world-Y. Glyph
      // upAxis is world-Y (see SymbolicTextPipeline), so subtracting
      // here puts line 1 below line 0 on screen for any side/oblique
      // 3D view of the floor plan.
      texts.push({
        worldPos: [t.x, y + (t.lineYOffset ?? 0), t.y],
        dirX: t.dirX,
        dirZ: t.dirY,
        height: t.height,
        content: t.content,
        alignment: t.alignment,
        billboard: t.billboard,
        color: t.color,
        targetPx: t.targetPx,
        definesExtent,
      });
    };
    const pushFill = (f: AnnotationFill2D, y: number, definesExtent: boolean) => {
      if (isHidden && isHidden(f.ownerId)) return;
      fills.push({
        points: f.points,
        holesOffsets: f.holesOffsets,
        worldY: y,
        color: f.color,
        hatching: f.hatching,
        definesExtent,
      });
    };

    // Bound once per branch, not spelled at each call: twelve literal
    // booleans is twelve chances to type `true` in the grid half.
    const pushAnnotationText = (t: AnnotationText2D, y: number) => pushText(t, y, true);
    const pushAnnotationFill = (f: AnnotationFill2D, y: number) => pushFill(f, y, true);
    const pushGridText = (t: AnnotationText2D, y: number) => pushText(t, y, false);
    const pushGridFill = (f: AnnotationFill2D, y: number) => pushFill(f, y, false);

    if (enabled) {
      for (const bucket of cached.byStorey.values()) {
        const y = resolveBucketY(bucket.storeyElevation, fallbackY);
        for (const t of bucket.texts) pushAnnotationText(t, y);
        for (const f of bucket.fills) pushAnnotationFill(f, y);
      }
      for (const t of cached.looseTexts) pushAnnotationText(t, fallbackY);
      for (const f of cached.looseFills) pushAnnotationFill(f, fallbackY);
    }

    if (effectiveGridEnabled) {
      // Issue #862: the section cut clips GRID content only — IfcAnnotation
      // deliberately bypasses this, the same rule the line channels follow.
      if (clipEnabled) {
        const lo = clipPos - clipDepth;
        const hi = clipPos + clipDepth;
        for (const bucket of cached.gridByStorey.values()) {
          const y = resolveBucketY(bucket.storeyElevation, fallbackY);
          if (y < lo || y > hi) continue;
          for (const t of bucket.texts) pushGridText(t, y);
          for (const f of bucket.fills) pushGridFill(f, y);
        }
        if (fallbackY >= lo && fallbackY <= hi) {
          for (const t of cached.gridLooseTexts) pushGridText(t, fallbackY);
          for (const f of cached.gridLooseFills) pushGridFill(f, fallbackY);
        }
      } else {
        for (const bucket of cached.gridByStorey.values()) {
          const y = resolveBucketY(bucket.storeyElevation, fallbackY);
          for (const t of bucket.texts) pushGridText(t, y);
          for (const f of bucket.fills) pushGridFill(f, y);
        }
        for (const t of cached.gridLooseTexts) pushGridText(t, fallbackY);
        for (const f of cached.gridLooseFills) pushGridFill(f, fallbackY);
      }
    }
  }

  return {
    texts: texts.length ? texts : EMPTY_TEXTS,
    fills: fills.length ? fills : EMPTY_FILLS,
  };
}
