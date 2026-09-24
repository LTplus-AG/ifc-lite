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
  AnnotationsForStorey,
  AnnotationText2D,
  ParseResult,
} from '../lib/overlay-parse/symbolic-parse.js';
import { resolveBucketY } from './useSymbolicAnnotations.js';
import { legibleAnnotationTextColor } from '@/lib/annotation-ink';
import type { ThemeMode } from '@/store/slices/uiSlice';

/**
 * Grid buckets in the order their bubbles are lifted: lowest resolved
 * elevation first, non-finite elevations last, ties in Map order (#5583).
 *
 * A structural grid is one axis system through every floor, but
 * `ensureBucket` (`symbolic-parse.ts`) buckets IfcGridAxis content by
 * elevation, so a bubble assigned per storey lands in EVERY storey's
 * `gridByStorey` bucket and a multi-storey model (Snowdon_Towers) stacked
 * one circle-and-label per floor down every column. Lifting the buckets
 * low-to-high and skipping any bubble already lifted at the same plan
 * position keeps the lowest copy of each duplicate, while a label that
 * exists only on an upper storey (a tower grid over a podium) still draws.
 * The parser only buckets finite elevations; ranking a non-finite one last
 * anyway keeps the comparator consistent, since `NaN` compares false both
 * ways and would scramble the order.
 */
function gridBucketsLowToHigh(
  gridByStorey: ReadonlyMap<number, AnnotationsForStorey>,
  fallbackY: number,
): { bucket: AnnotationsForStorey; y: number }[] {
  const rank = (y: number) => (Number.isFinite(y) ? y : Infinity);
  return [...gridByStorey.values()]
    .map((bucket) => ({ bucket, y: resolveBucketY(bucket.storeyElevation, fallbackY) }))
    .sort((a, b) => rank(a.y) - rank(b.y) || 0);
}

/** Plan-space identity of a grid bubble text: same label, anchor and
 *  direction means the same bubble repeated on another storey. */
function gridTextKey(t: AnnotationText2D): string {
  return `${t.content}\u0000${t.x},${t.y},${t.dirX},${t.dirY}`;
}

/** Plan-space identity of a grid bubble fill: its outline points. */
function gridFillKey(f: AnnotationFill2D): string {
  return f.points.join(',');
}

/**
 * A text annotation lifted into 3D world space.
 *
 * `worldPos[1]` is the storey Y the annotation belongs to (or `fallbackY` for
 * orphans). `dirX / dirZ` is the baseline direction in 3D (already mirrored
 * from the IFC frame to match the section overlay's coordinate handedness).
 * `height` is in world units.
 */
export interface AnnotationText3D {
  /** Canonical f64 anchor; the renderer projects this separately from glyph-local offsets. */
  origin: [number, number, number];
  /** Small local label offset from `origin` (currently zero for parsed labels). */
  worldPos: [number, number, number];
  dirX: number;
  dirZ: number;
  height: number;
  content: string;
  alignment: string;
  /** True when the glyph quad should rebuild in camera-aligned basis (grid tags). */
  billboard?: boolean;
  /** sRGB straight-alpha tint, 0..1, already resolved for the theme (#5388). */
  color: [number, number, number, number];
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
  /** f64 anchor when this fill came from a placed source-local ring. */
  origin?: [number, number, number];
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
  isMeshedFill?: (ownerId: number, geometryItemId: number) => boolean;
}

interface SymbolicRichChannelsParams {
  enabled: boolean;
  effectiveGridEnabled: boolean;
  clipEnabled: boolean;
  clipPos: number;
  clipDepth: number;
  fallbackY: number;
  /** Labels are recoloured to stay legible on this theme's backdrop (#5388). */
  theme: ThemeMode;
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
  const { enabled, effectiveGridEnabled, clipEnabled, clipPos, clipDepth, fallbackY, theme } = params;
  if (!enabled && !effectiveGridEnabled) return EMPTY_RICH_CHANNELS;

  const texts: AnnotationText3D[] = [];
  const fills: AnnotationFill3D[] = [];

  for (const { cached, isHidden, isMeshedFill } of entries) {
    // `definesExtent`: see [`AnnotationText3D.definesExtent`] for why the
    // channel routing does not reach bubbles (#3359).
    // Both return whether the item was lifted, so the grid dedup below only
    // claims a bubble's plan position once a copy of it actually draws.
    const pushText = (t: AnnotationText2D, y: number, definesExtent: boolean): boolean => {
      if (isHidden && isHidden(t.ownerId)) return false;
      // lineYOffset stacks multi-line text downward in world-Y. Glyph
      // upAxis is world-Y (see SymbolicTextPipeline), so subtracting
      // here puts line 1 below line 0 on screen for any side/oblique
      // 3D view of the floor plan.
      texts.push({
        // One source label gets one canonical anchor. Keeping its local
        // position at zero prevents a 5,000-km source coordinate from ever
        // entering the f32 instance origin, while preserving f64 parser
        // coordinates until the RTE split at GPU ingress.
        origin: [t.x, y + (t.lineYOffset ?? 0), t.y],
        worldPos: [0, 0, 0],
        dirX: t.dirX,
        dirZ: t.dirY,
        height: t.height,
        content: t.content,
        alignment: t.alignment,
        billboard: t.billboard,
        // Theme ink for an unstyled label; an authored colour too close to the
        // backdrop is pulled toward the ink just far enough to read (#5388).
        color: legibleAnnotationTextColor(t.color, theme),
        targetPx: t.targetPx,
        definesExtent,
      });
      return true;
    };
    const pushFill = (f: AnnotationFill2D, y: number, definesExtent: boolean): boolean => {
      if (isHidden && isHidden(f.ownerId)) return false;
      // Keep the cached 2D drawing intact. Only the redundant 3D lift is
      // omitted, and only for an exact owner/item match in this model.
      if (f.geometryItemId !== undefined && isMeshedFill?.(f.ownerId, f.geometryItemId)) return false;
      fills.push({
        points: f.rteLocalPoints ?? f.points,
        holesOffsets: f.holesOffsets,
        worldY: f.rteOrigin ? y - f.rteOrigin[1] : y,
        origin: f.rteOrigin,
        color: f.color,
        hatching: f.hatching,
        definesExtent,
      });
      return true;
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
      // #5583: a bubble repeated on every storey is lifted once, from the
      // lowest storey that draws it — see `gridBucketsLowToHigh`.
      const seenTexts = new Set<string>();
      const seenFills = new Set<string>();
      // Issue #862: the section cut clips GRID content only — IfcAnnotation
      // deliberately bypasses this, the same rule the line channels follow.
      const lo = clipPos - clipDepth;
      const hi = clipPos + clipDepth;
      const inClip = (y: number) => !clipEnabled || (y >= lo && y <= hi);
      const liftBubbles = (bubbleTexts: readonly AnnotationText2D[], bubbleFills: readonly AnnotationFill2D[], y: number) => {
        if (!inClip(y)) return;
        for (const t of bubbleTexts) {
          const key = gridTextKey(t);
          if (!seenTexts.has(key) && pushGridText(t, y)) seenTexts.add(key);
        }
        for (const f of bubbleFills) {
          const key = gridFillKey(f);
          if (!seenFills.has(key) && pushGridFill(f, y)) seenFills.add(key);
        }
      };
      for (const { bucket, y } of gridBucketsLowToHigh(cached.gridByStorey, fallbackY)) {
        liftBubbles(bucket.texts, bucket.fills, y);
      }
      // Unresolved-elevation copies are the same bubbles; they only fill in
      // positions no storey drew.
      liftBubbles(cached.gridLooseTexts, cached.gridLooseFills, fallbackY);
    }
  }

  return {
    texts: texts.length ? texts : EMPTY_TEXTS,
    fills: fills.length ? fills : EMPTY_FILLS,
  };
}
