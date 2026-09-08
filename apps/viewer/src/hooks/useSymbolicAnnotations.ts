/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lazy extraction of IfcAnnotation 2D curves for the section-plane overlay.
 *
 * The WASM `parseSymbolicRepresentations` already emits polylines and arcs in
 * the same 2D coordinate space the Section2DPanel feeds to
 * `Section2DOverlayRenderer`. We only ever need the data when the IFC
 * Annotation toggle is on AND a section plane is active, so the parse runs
 * lazily and is cached per model source.
 */

import { useEffect, useMemo, useState } from 'react';
import type { DrawingLine2D } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import type { IfcDataStore } from '@ifc-lite/parser';
import {
  debugEnabled,
  type AnnotationFill2D,
  type AnnotationText2D,
  type AnnotationsForStorey,
} from '../lib/overlay-parse/symbolic-parse.js';
import { ensureParseFor, getParseFor, subscribeToParseCache } from './symbolic-parse-cache.js';
import { useOverlayChannelGate } from './useOverlayChannelGate.js';
import {
  buildSymbolicLineChannels,
  type SymbolicLineChannels,
  type SymbolicLineChannelsEntry,
} from './symbolic-line-channels.js';
import {
  buildSymbolicRichChannels,
  EMPTY_RICH_CHANNELS,
  type AnnotationFill3D,
  type AnnotationText3D,
  type SymbolicRichChannels,
  type SymbolicRichChannelsEntry,
} from './symbolic-rich-channels.js';

// The parse walk itself lives in `lib/overlay-parse/symbolic-parse.ts` so a
// worker can import it (a worker module cannot import this React hook file).
// Re-exported here so existing consumers keep their import paths.
export type { AnnotationsForStorey, AnnotationText2D, AnnotationFill2D };
export { polylineToSegments, circleToSegments } from '../lib/overlay-parse/symbolic-parse.js';

/**
 * Lift 2D annotation lines (renderer XZ space) to a flat Float32Array of
 * 3D line-list vertices `[x1, y, z1, x2, y, z2, …]`. The Y coordinate is
 * the annotation's storey elevation in world space, so the resulting
 * lines render at the right floor when drawn through the renderer's
 * world-space line pipeline.
 *
 * Exported for unit testing.
 */
export function liftTo3DLineList(
  lines: DrawingLine2D[],
  y: number,
  out: number[],
  isHidden?: (ownerId: number) => boolean,
): void {
  for (const line of lines) {
    if (isHidden && line.ownerId !== undefined && isHidden(line.ownerId)) continue;
    out.push(line.line.start.x, y, line.line.start.y);
    out.push(line.line.end.x,   y, line.line.end.y);
  }
}

/**
 * Returns IFC annotation segments as a single Float32Array of pre-lifted 3D
 * line-list vertices in world space, ready to feed
 * `renderer.setLineOverlay('annotation', …)`.
 *
 * Each annotation is lifted to its containing storey's elevation. Annotations
 * with no resolvable storey fall back to `fallbackY` (typically the mid-Y of
 * the scene bounds) so the overlay stays visible even when the IFC file's
 * spatial hierarchy doesn't link annotations to a storey — common when the
 * authoring tool encodes the storey Z directly on the placement point
 * instead of on `IfcBuildingStorey.Elevation`.
 *
 * When `enabled` is false (toggle off, no models, etc.) the hook does no
 * parse work and returns a stable empty Float32Array. Parsing is lazy —
 * the WASM `parseSymbolicRepresentations` call only runs after the toggle
 * is turned on, and the result is cached per model source.
 */
const EMPTY_F32 = new Float32Array(0);

/** One active model's data store plus the identity needed to map a parsed
 *  primitive's LOCAL express id to the federated global id the visibility
 *  sets are keyed by. `idOffset` is 0 for the legacy single-model path. */
interface ActiveStore {
  store: IfcDataStore;
  modelId: string;
  idOffset: number;
}

/** Read the active store set from the viewer store. Federation-aware. */
function useActiveStores(): ActiveStore[] {
  const { models, ifcDataStore } = useViewerStore(
    useShallow((s) => ({ models: s.models, ifcDataStore: s.ifcDataStore })),
  );
  return useMemo(() => {
    const out: ActiveStore[] = [];
    if (models.size > 0) {
      for (const [modelId, m] of models) {
        if (m.ifcDataStore) out.push({ store: m.ifcDataStore, modelId, idOffset: m.idOffset ?? 0 });
      }
    } else if (ifcDataStore) {
      out.push({ store: ifcDataStore, modelId: 'legacy', idOffset: 0 });
    }
    return out;
  }, [models, ifcDataStore]);
}

/** Trigger parse for the active stores when `enabled`, tick on completion. */
function useAnnotationParseTrigger(enabled: boolean, stores: ActiveStore[]): number {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    ensureParseFor(stores.map((s) => s.store));
    return subscribeToParseCache(() => setVersion((v) => v + 1));
  }, [enabled, stores]);

  return version;
}

/**
 * The per-entity hidden sets that gate the annotation overlay. An annotation's
 * curves/text/fills are dropped when the owning entity has been hidden through
 * the hierarchy panel, a lens, or a federated per-model hide — mirroring how
 * hiding a meshed element (e.g. the "Model Text" brep) removes it. Isolation
 * filters (storey solo, class filter) are intentionally NOT applied: annotation
 * buckets lift to every storey by design (see
 * `feedback_3d_annotation_overlay_no_section_filter`), and `byStorey` omits
 * annotations, so honouring storey isolation here would wrongly blank them.
 */
interface HiddenOwnerSets {
  global: ReadonlySet<number>;
  lens: ReadonlySet<number>;
  byModel: ReadonlyMap<string, Set<number>>;
}

const EMPTY_NUM_SET: ReadonlySet<number> = new Set<number>();

function useHiddenOwnerSets(): HiddenOwnerSets {
  return useViewerStore(
    useShallow((s) => ({
      global: s.hiddenEntities,
      lens: s.lensHiddenIds,
      byModel: s.hiddenEntitiesByModel,
    })),
  );
}

/** Build a per-store predicate: is this annotation owner (LOCAL express id)
 *  currently hidden? Cheap fast-path when nothing is hidden. */
function makeHiddenOwnerPredicate(
  entry: ActiveStore,
  sets: HiddenOwnerSets,
): ((ownerId: number) => boolean) | undefined {
  const perModel = sets.byModel.get(entry.modelId) ?? EMPTY_NUM_SET;
  if (sets.global.size === 0 && sets.lens.size === 0 && perModel.size === 0) return undefined;
  const offset = entry.idOffset;
  return (ownerId: number): boolean => {
    if (perModel.has(ownerId)) return true;
    const globalId = ownerId + offset;
    return sets.global.has(globalId) || sets.lens.has(globalId);
  };
}

/** Resolve the world-space Y for a storey bucket.
 *
 * `null` elevation means the storey carried no value in the parsed metadata
 * (rare but happens in older authoring tools that leave
 * `IfcBuildingStorey.Elevation` blank and bake the Z into the placements);
 * fall back to the caller's `fallbackY` (typically the model's mid-Y). A
 * real ground floor at 0.0 keeps its authored 0 instead of being remapped.
 */
export function resolveBucketY(elevation: number | null, fallbackY: number): number {
  return elevation === null ? fallbackY : elevation;
}

/** Section-clip parameters for grid lines (issue #862). Grids ARE clipped
 *  by the active section plane; IfcAnnotation overlays are NOT (per the
 *  feedback_3d_annotation_overlay_no_section_filter memory). When
 *  `enabled === false` no clipping happens — grids lift to every storey
 *  same as annotations.
 */
export interface SectionClipForGrid {
  enabled: boolean;
  /** World coord on the cut axis (e.g. world-Y for axis='down'). */
  posWorld: number;
  /** Half-thickness of the visible band around the cut, world units. */
  viewDepth: number;
  /** Cut axis. Only `'down'` performs vertical clipping; other axes pass through unfiltered (grid lines are vertical and don't project meaningfully onto elevation cuts). */
  axis: 'down' | 'front' | 'side';
}

// `buildSymbolicLineChannels` (the pure annotation/grid merge, issue #3359)
// lives in `symbolic-line-channels.ts` — split out to keep this file under
// budget and so it can be unit-tested with no React/store/WASM dependency.
// Re-exported here so existing consumers keep this import path.
export { buildSymbolicLineChannels, type SymbolicLineChannels, type SymbolicLineChannelsEntry };

// `buildSymbolicRichChannels` (the pure text/fill merge) and the
// `AnnotationText3D` / `AnnotationFill3D` shapes it produces live in
// `symbolic-rich-channels.ts` — split out for the same two reasons as the line
// channels above, and so the grid section-clip band it applies has a seam a
// test can reach with no worker, no parse cache and no React (issue #3393).
// Re-exported narrowly: `SymbolicRichChannels` names the return type of the
// hook below, and `AnnotationText3D` / `AnnotationFill3D` keep this import
// path working for the callers that already used it (today only
// `useSymbolicAnnotations.gridBubbleExtent.test.tsx`; `Viewport.tsx` consumes
// the shapes structurally without naming them). The builder and its entry type
// have no consumer here and are imported from their own module instead.
export { type AnnotationFill3D, type AnnotationText3D, type SymbolicRichChannels };

export function useSymbolicAnnotations(params: {
  /** Enable IfcAnnotation lift (the existing default behaviour). */
  enabled: boolean;
  /**
   * Enable IfcGrid lift. Independent of `enabled` so a user can hide
   * annotations while keeping grids, or vice versa (issue #862).
   * Defaults to `enabled` so existing call sites that don't set it
   * keep the legacy combined behaviour.
   */
  gridEnabled?: boolean;
  /** Section clipping for grids only — see [`SectionClipForGrid`]. */
  gridSectionClip?: SectionClipForGrid;
  /** World Y to use for annotations with no resolvable storey. Defaults to 0. */
  fallbackY?: number;
}): SymbolicLineChannels {
  const { gridSectionClip, fallbackY = 0 } = params;
  const { annotation: enabled, grid: effectiveGridEnabled } =
    useOverlayChannelGate(params.enabled, params.gridEnabled ?? params.enabled);
  const stores = useActiveStores();
  const hiddenSets = useHiddenOwnerSets();
  // Trigger parse if EITHER subset is enabled — the parse pass is shared.
  const version = useAnnotationParseTrigger(enabled || effectiveGridEnabled, stores);
  const clipEnabled = !!gridSectionClip && gridSectionClip.enabled && gridSectionClip.axis === 'down';
  const clipPos = clipEnabled ? gridSectionClip!.posWorld : 0;
  const clipDepth = clipEnabled ? gridSectionClip!.viewDepth : 0;

  return useMemo(() => {
    if (!enabled && !effectiveGridEnabled) return { annotation: EMPTY_F32, grid: EMPTY_F32 };
    void version; // depend on parse-completion ticks

    // Per-entity hide: an annotation/grid owner hidden via the hierarchy, a
    // lens, or a federated per-model hide drops its overlay primitives.
    // Stores whose parse isn't cached yet drop out (logged below).
    const entries: SymbolicLineChannelsEntry[] = [];
    for (const entry of stores) {
      const cached = getParseFor(entry.store);
      if (cached) entries.push({ cached, isHidden: makeHiddenOwnerPredicate(entry, hiddenSets) });
      else if (debugEnabled()) console.log(`[annotations] store not yet ready: ${entry.modelId}`);
    }

    return buildSymbolicLineChannels(entries, {
      enabled,
      effectiveGridEnabled,
      clipEnabled,
      clipPos,
      clipDepth,
      fallbackY,
    });
  }, [enabled, effectiveGridEnabled, clipEnabled, clipPos, clipDepth, stores, hiddenSets, version, fallbackY]);
}

/**
 * Hook for the 2D Section panel: filters the shared parse cache to
 * annotations whose world position falls inside the section's view-range
 * on the cut axis, returning data in the Drawing2D coordinate frame.
 *
 * For `axis='down'` (floor plan), the parser's 2D coords already match
 * the drawing-2d coord frame directly (x = world x, y = world z, with
 * worldY = the cut axis). For elevation views (`axis='front'`,
 * `axis='side'`), this hook returns empty: most authored IFC annotations
 * are floor-plan symbols (dimensions, leaders, room labels) and don't
 * project meaningfully onto a vertical drawing without a separate
 * reorientation pass. Wiring those up cleanly is a follow-up.
 *
 * The section position is in world units (already converted from the
 * 0-100% slider via `axisMin + (position / 100) * (axisMax - axisMin)`
 * by the caller — Section2DPanel computes the same value to feed the
 * drawing generator).
 */
export interface DrawingAnnotationData {
  lines: DrawingLine2D[];
  texts: AnnotationText2D[];
  fills: AnnotationFill2D[];
}

const EMPTY_DRAWING_ANNOTATIONS: DrawingAnnotationData = {
  lines: [],
  texts: [],
  fills: [],
};

/**
 * Whether `Section2DPanel` should ask this hook for data at all.
 *
 * Pulled out of the call site as its own predicate (rather than an inline
 * `&&` chain) so the gate is unit-testable independent of `Section2DPanel`,
 * which imports `useIfc` → `ifcConfig.ts` → `import.meta.env` and is
 * consequently unrenderable under this repo's `tsx --test` runner
 * (`import.meta.env` is `undefined` outside a Vite build).
 *
 * The section's own class-level Visibility toggles gate every other route
 * into the drawing — the cut mesh filter and the construction-projection
 * profile filter both read `typeVisibility` via `isTypeVisible` (#2060). The
 * symbolic annotation overlay used to be the one exception: it read only
 * `showIfcAnnotations` (the per-drawing "show this overlay" toggle) and
 * `status`, so turning the class-level IfcAnnotation toggle off in the 3D
 * viewport — which hides IfcAnnotation there via `typeVisibilityFilter.ts`
 * — left the symbolic overlay drawing anyway (issue #2121).
 */
export function symbolicAnnotationsOverlayEnabled(
  showIfcAnnotations: boolean,
  drawingStatus: string,
  ifcAnnotationsClassVisible: boolean,
): boolean {
  return showIfcAnnotations && drawingStatus === 'ready' && ifcAnnotationsClassVisible;
}

export function useSymbolicAnnotationsForDrawing(params: {
  enabled: boolean;
  axis: 'down' | 'front' | 'side';
  /** Section plane world-coord position along the cut axis. */
  sectionPosWorld: number;
  /** View depth in world units (typically half the model extent on the cut axis). */
  viewDepth: number;
  flipped: boolean;
  /** Fallback world Y for annotations with no resolvable storey. */
  fallbackY?: number;
}): DrawingAnnotationData {
  const { enabled, axis, sectionPosWorld, viewDepth, flipped, fallbackY = 0 } = params;
  const stores = useActiveStores();
  const version = useAnnotationParseTrigger(enabled, stores);

  return useMemo(() => {
    if (!enabled) return EMPTY_DRAWING_ANNOTATIONS;
    // Only floor plans (axis='down') are supported on this pass. Annotations
    // for elevations/sections need a coord-reorientation pass that is not
    // worth building until there's a real authored elevation symbol to test
    // against. Returning empty quietly keeps the toggle a no-op there.
    if (axis !== 'down') return EMPTY_DRAWING_ANNOTATIONS;
    void version;

    // Section view range in world Y.
    //
    // For a floor-plan cut at axis='down' the camera looks DOWN through the
    // cut. "In front of the camera" is therefore the side BELOW the cut —
    // where the floor and authored dimensions sit (IFC convention places
    // dimension annotations at the storey's floor elevation, not at the
    // cut height). The user's complaint: with the slab on the +normal
    // side, you had to scrub the section DOWN into the floor before
    // anything showed, and then the dimensions appeared one storey BELOW
    // the cut. Mirror that — keep the slab on the −normal side for the
    // unflipped down section, and flip it for the reflected-ceiling case.
    //
    // Note this DIVERGES from `profile-projector.isInProjectionRange`,
    // which projects above the cut by default. Annotations live with the
    // storey floor, the projection lives with the upper-storey volume —
    // they're naturally on opposite sides of the cut plane.
    //
    // Tolerance lets annotations authored exactly on the cut plane (e.g.
    // a storey at Z=0 with a section right at the storey datum) survive.
    const TOL = 1e-3;
    const rangeMin = (flipped ? sectionPosWorld : sectionPosWorld - viewDepth) - TOL;
    const rangeMax = (flipped ? sectionPosWorld + viewDepth : sectionPosWorld) + TOL;

    const lines: DrawingLine2D[] = [];
    const texts: AnnotationText2D[] = [];
    const fills: AnnotationFill2D[] = [];

    // The drawing-2d cutter negates the 2D U axis on flipped cardinal cuts
    // (see `projectTo2D` in @ifc-lite/drawing-2d/math.ts and `flipU` in the
    // GPU cutter). Annotation primitives come out of WASM in the cutter's
    // UNFLIPPED basis, so on a flipped section they'd sit beside the model
    // (mirrored across X=0) instead of on top of it — exactly the
    // "dimensions floating to the right of the floor plan" symptom. Mirror
    // X for lines/texts/fills here so they line up with the section cut
    // output drawn underneath. Y stays put (the cutter only flips U).
    const pushLine = flipped
      ? (ln: DrawingLine2D) => lines.push({
          line: {
            start: { x: -ln.line.start.x, y: ln.line.start.y },
            end:   { x: -ln.line.end.x,   y: ln.line.end.y   },
          },
          category: ln.category,
        })
      : (ln: DrawingLine2D) => lines.push(ln);
    const pushText = flipped
      ? (t: AnnotationText2D) => texts.push({ ...t, x: -t.x, dirX: -t.dirX })
      : (t: AnnotationText2D) => texts.push(t);
    const pushFill = flipped
      ? (f: AnnotationFill2D) => {
          const src = f.points;
          const dst = new Float32Array(src.length);
          for (let i = 0; i < src.length; i += 2) {
            dst[i]     = -src[i];
            dst[i + 1] =  src[i + 1];
          }
          fills.push({ ...f, points: dst });
        }
      : (f: AnnotationFill2D) => fills.push(f);

    for (const entry of stores) {
      const cached = getParseFor(entry.store);
      if (!cached) continue;

      // Drawing-2D pulls BOTH annotation and grid buckets (issue #862
      // split them at parse time so the 3D viewport can clip them
      // separately — the 2D Section panel still wants the combined
      // overlay).
      const collectBucket = (bucket: AnnotationsForStorey) => {
        const bucketY = resolveBucketY(bucket.storeyElevation, fallbackY);
        if (bucketY < rangeMin || bucketY > rangeMax) return;
        for (const ln of bucket.lines) pushLine(ln);
        for (const t of bucket.texts) pushText(t);
        for (const f of bucket.fills) pushFill(f);
      };
      for (const bucket of cached.byStorey.values()) collectBucket(bucket);
      for (const bucket of cached.gridByStorey.values()) collectBucket(bucket);

      // Loose annotations have no resolvable storey — include them if the
      // fallback Y lands in the view range. That keeps malformed exports
      // (e.g. 3DEXPERIENCE files with orphaned storeys) usable when the
      // user is looking at the storey the fallback resolves to.
      if (fallbackY >= rangeMin && fallbackY <= rangeMax) {
        for (const ln of cached.loose) pushLine(ln);
        for (const t of cached.looseTexts) pushText(t);
        for (const f of cached.looseFills) pushFill(f);
        for (const ln of cached.gridLoose) pushLine(ln);
        for (const t of cached.gridLooseTexts) pushText(t);
        for (const f of cached.gridLooseFills) pushFill(f);
      }
    }

    if (lines.length === 0 && texts.length === 0 && fills.length === 0) {
      return EMPTY_DRAWING_ANNOTATIONS;
    }
    return { lines, texts, fills };
  }, [enabled, axis, sectionPosWorld, viewDepth, flipped, fallbackY, stores, version]);
}

/**
 * Hook for the WebGPU text + fill pipelines. Returns 3D-lifted texts and
 * fills for every active model. Shares the parse cache with
 * `useSymbolicAnnotations` so toggling on text+fill rendering after the
 * line overlay is already up costs no extra parse work.
 */
export function useSymbolicAnnotationsRichData(params: {
  enabled: boolean;
  /** Lift grid-bubble texts + fills. Independent of `enabled` (issue #862).
   *  Defaults to `enabled` for legacy callers. */
  gridEnabled?: boolean;
  /** Section clipping for grid texts/fills only — same semantics as
   *  [`useSymbolicAnnotations`]. */
  gridSectionClip?: SectionClipForGrid;
  fallbackY?: number;
}): SymbolicRichChannels {
  const { gridSectionClip, fallbackY = 0 } = params;
  const { annotation: enabled, grid: effectiveGridEnabled } =
    useOverlayChannelGate(params.enabled, params.gridEnabled ?? params.enabled);
  const stores = useActiveStores();
  const hiddenSets = useHiddenOwnerSets();
  const version = useAnnotationParseTrigger(enabled || effectiveGridEnabled, stores);
  const clipEnabled = !!gridSectionClip && gridSectionClip.enabled && gridSectionClip.axis === 'down';
  const clipPos = clipEnabled ? gridSectionClip!.posWorld : 0;
  const clipDepth = clipEnabled ? gridSectionClip!.viewDepth : 0;

  return useMemo(() => {
    if (!enabled && !effectiveGridEnabled) return EMPTY_RICH_CHANNELS;
    void version; // depend on parse-completion ticks

    // Per-entity hide: drop text/fills whose owning annotation is hidden.
    // Stores whose parse isn't cached yet drop out.
    const entries: SymbolicRichChannelsEntry[] = [];
    for (const entry of stores) {
      const cached = getParseFor(entry.store);
      if (cached) entries.push({ cached, isHidden: makeHiddenOwnerPredicate(entry, hiddenSets) });
    }

    return buildSymbolicRichChannels(entries, {
      enabled,
      effectiveGridEnabled,
      clipEnabled,
      clipPos,
      clipDepth,
      fallbackY,
    });
  }, [enabled, effectiveGridEnabled, clipEnabled, clipPos, clipDepth, stores, hiddenSets, version, fallbackY]);
}
