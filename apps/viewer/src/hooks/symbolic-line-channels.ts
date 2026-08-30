/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pure merge step behind `useSymbolicAnnotations` — split out so it can
 * be unit-tested against a hand-built `ParseResult` with no React/store/WASM
 * dependency, and so the hook file stays under the module-size budget.
 *
 * Kept SEPARATE (issue #3359): annotation/grid used to share one buffer
 * feeding `setLineOverlay('annotation', …)`, so a grid-only session reached
 * a channel whose `CHANNEL_EXPANDS_MODEL_BOUNDS` entry is `true` — the
 * opposite of `grid`'s `false` (issue #967: grid axes extend past the
 * model) — inflating the scene bounds every camera fit / empty-space orbit
 * pivot (`useMouseControls.ts`/`useTouchControls.ts`) then reframed onto.
 * Callers upload `annotation`/`grid` to their like-named channel.
 */

import { debugEnabled, type ParseResult } from '../lib/overlay-parse/symbolic-parse.js';
import { liftTo3DLineList, resolveBucketY } from './useSymbolicAnnotations.js';

const EMPTY_F32 = new Float32Array(0);

export interface SymbolicLineChannels {
  annotation: Float32Array;
  grid: Float32Array;
}

/** One store's parsed buckets + hide predicate — no React/WASM dependency,
 *  so `buildSymbolicLineChannels` runs against a hand-built `ParseResult`
 *  in a test. */
export interface SymbolicLineChannelsEntry {
  cached: ParseResult;
  isHidden?: (ownerId: number) => boolean;
}

interface SymbolicLineChannelsParams {
  enabled: boolean;
  effectiveGridEnabled: boolean;
  clipEnabled: boolean;
  clipPos: number;
  clipDepth: number;
  fallbackY: number;
}

/** Pure merge of every store's annotation/grid buckets into two flat 3D
 *  line-list buffers. Exported for unit testing. */
export function buildSymbolicLineChannels(
  entries: readonly SymbolicLineChannelsEntry[],
  params: SymbolicLineChannelsParams,
): SymbolicLineChannels {
  const { enabled, effectiveGridEnabled, clipEnabled, clipPos, clipDepth, fallbackY } = params;
  if (!enabled && !effectiveGridEnabled) return { annotation: EMPTY_F32, grid: EMPTY_F32 };

  const annotationVerts: number[] = [];
  const gridVerts: number[] = [];
  for (const { cached, isHidden } of entries) {
    if (enabled) {
      for (const bucket of cached.byStorey.values()) {
        liftTo3DLineList(bucket.lines, resolveBucketY(bucket.storeyElevation, fallbackY), annotationVerts, isHidden);
      }
      liftTo3DLineList(cached.loose, fallbackY, annotationVerts, isHidden);
    }

    if (effectiveGridEnabled) {
      // Issue #862: section-clip grid buckets only — IfcAnnotation
      // intentionally bypasses this per the feedback memory ("the
      // user expects every storey's dimensions/grid bubbles to lift
      // into the viewport when [the annotation toggle is] on, even
      // while a section cut is active").
      if (clipEnabled) {
        const lo = clipPos - clipDepth;
        const hi = clipPos + clipDepth;
        for (const bucket of cached.gridByStorey.values()) {
          const y = resolveBucketY(bucket.storeyElevation, fallbackY);
          if (y < lo || y > hi) continue;
          liftTo3DLineList(bucket.lines, y, gridVerts, isHidden);
        }
        if (fallbackY >= lo && fallbackY <= hi) {
          liftTo3DLineList(cached.gridLoose, fallbackY, gridVerts, isHidden);
        }
      } else {
        for (const bucket of cached.gridByStorey.values()) {
          liftTo3DLineList(bucket.lines, resolveBucketY(bucket.storeyElevation, fallbackY), gridVerts, isHidden);
        }
        liftTo3DLineList(cached.gridLoose, fallbackY, gridVerts, isHidden);
      }
    }
  }

  if (debugEnabled()) {
    console.log(
      `[annotations] total 3D line vertices: ${annotationVerts.length / 3} annotation + ${gridVerts.length / 3} grid from ${entries.length} stores`,
    );
  }
  return {
    annotation: annotationVerts.length === 0 ? EMPTY_F32 : new Float32Array(annotationVerts),
    grid: gridVerts.length === 0 ? EMPTY_F32 : new Float32Array(gridVerts),
  };
}
