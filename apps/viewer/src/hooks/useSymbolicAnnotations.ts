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

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DrawingLine2D } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import type { IfcDataStore } from '@ifc-lite/parser';
import { hasEntityType } from './has-entity-type.js';
import {
  buildParseResult,
  createEmptyParseResult,
  debugEnabled,
  type AnnotationFill2D,
  type AnnotationText2D,
  type AnnotationsForStorey,
  type ParseResult,
} from '../lib/overlay-parse/symbolic-parse.js';
import { getWholeSourceForWorker, parseSymbolicFlat } from '../lib/overlay-parse/index.js';

// The parse walk itself lives in `lib/overlay-parse/symbolic-parse.ts` so a
// worker can import it (a worker module cannot import this React hook file).
// Re-exported here so existing consumers keep their import paths.
export type { AnnotationsForStorey, AnnotationText2D, AnnotationFill2D };
export { polylineToSegments, circleToSegments } from '../lib/overlay-parse/symbolic-parse.js';

/**
 * Stable cache key for one parsed source.
 *
 * Was a sampled hash (head/middle/tail, 96 bytes) chosen to avoid walking the
 * whole file. `IfcSourceBytes.contentKey` is a full-content hash computed once
 * and cached on the source, so this is now both cheaper per call and stronger:
 * the sampled form could alias two files sharing a size and those windows,
 * which showed up as a federated model's annotations silently not rendering
 * because the parse effect skipped it as already cached (#2183).
 */
function sourceKey(store: IfcDataStore | null | undefined): string | null {
  return store?.source.contentKey ?? null;
}

/**
 * Parse one store's symbolic annotations.
 *
 * The WASM walk runs in the overlay worker (`lib/overlay-parse`); this
 * wrapper supplies the entity-index pre-filter, which needs
 * `store.entityIndex`, and reassembles the flat primitive stream into buckets
 * with the storey lookups, which never leave the main thread.
 */
async function parseAnnotations(
  store: IfcDataStore,
): Promise<ParseResult> {
  const source = store.source;
  // Skip the full-source WASM scan only when the model has neither IfcAnnotation
  // nor IfcGridAxis — this parse path ALSO feeds the grid buckets (gridByStorey /
  // gridLoose*), so gating on IfcAnnotation alone would drop grid-only models.
  // The scan copies the entire IFC source into the WASM heap on the main thread,
  // so skipping it when there is nothing to find still matters.
  //
  if (source && source.byteLength > 0 && !hasEntityType(store, 'IfcAnnotation', 'IfcGridAxis')) {
    if (debugEnabled()) console.log('[annotations] skip: no IfcAnnotation/IfcGridAxis entities');
    return createEmptyParseResult();
  }
  if (!source || source.byteLength === 0) {
    if (debugEnabled()) console.log('[annotations] skip: missing/empty source');
    return createEmptyParseResult();
  }

  // The WASM walk runs in the overlay worker and is terminated afterwards;
  // running it here grew a main-thread WASM heap that never shrinks, worth
  // ~471 MB on a 342 MB model (#2183). Only the flat primitive stream crosses
  // back — bucketing stays here, so the storey lookups never leave the main
  // thread and `ensureBucket` keeps its exact semantics.
  // `getWholeSourceForWorker` is the single seam for handing a model's bytes
  // to a worker — see `lib/overlay-parse/source-handoff.ts`.
  const flat = await parseSymbolicFlat(getWholeSourceForWorker(store), debugEnabled());
  return buildParseResult(flat, {
    elementToStorey: store.spatialHierarchy?.elementToStorey,
    storeyElevations: store.spatialHierarchy?.storeyElevations,
  });
}

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
 * `renderer.uploadAnnotationLines3D`.
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

// ─── Shared parse cache ─────────────────────────────────────────────────────
// Parsing the whole file's symbolic representations is not cheap (full WASM
// walk over every product's representations). Cache results module-globally
// so the line / text / fill hooks share one parse per model source instead
// of triggering it once per hook.
const PARSE_CACHE = new Map<string, ParseResult>();
const PARSE_INFLIGHT = new Map<string, Promise<void>>();

/** Subscribers that want to re-render when a new parse result lands. */
type CacheListener = () => void;
const CACHE_LISTENERS = new Set<CacheListener>();
function notifyCacheChange(): void {
  for (const fn of CACHE_LISTENERS) fn();
}

/**
 * Exported for unit testing (retry-storm regression, see
 * `useSymbolicAnnotations.retryStorm.test.ts`). Returns the in-flight
 * promises so a test can await completion without polling module state.
 */
export function ensureParseFor(stores: IfcDataStore[]): Promise<void>[] {
  const started: Promise<void>[] = [];
  for (const store of stores) {
    const key = sourceKey(store);
    if (!key) continue;
    if (PARSE_CACHE.has(key)) continue;
    const existing = PARSE_INFLIGHT.get(key);
    if (existing) {
      started.push(existing);
      continue;
    }

    const promise = (async () => {
      try {
        const result = await parseAnnotations(store);
        PARSE_CACHE.set(key, result);
        notifyCacheChange();
      } catch (error) {
        // Cache empty on failure so we don't retry a doomed parse every tick
        // (matches useGridLines3D / useAlignmentLines3D — a model whose
        // annotation section is malformed would otherwise re-run the
        // full-source WASM walk on every `stores` dependency change).
        // eslint-disable-next-line no-console
        console.warn('[useSymbolicAnnotations] parse failed:', error);
        PARSE_CACHE.set(key, createEmptyParseResult());
        notifyCacheChange();
      } finally {
        PARSE_INFLIGHT.delete(key);
      }
    })();
    PARSE_INFLIGHT.set(key, promise);
    started.push(promise);
  }
  return started;
}

/** @internal test-only reset of the module-level parse cache. */
export function __resetSymbolicAnnotationsCacheForTests(): void {
  PARSE_CACHE.clear();
  PARSE_INFLIGHT.clear();
}

/** @internal test-only peek at how many entries are cached for a source key. */
export function __symbolicAnnotationsCacheHasForTests(key: string): boolean {
  return PARSE_CACHE.has(key);
}

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
    const listener: CacheListener = () => setVersion((v) => v + 1);
    CACHE_LISTENERS.add(listener);
    return () => {
      CACHE_LISTENERS.delete(listener);
    };
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
function resolveBucketY(elevation: number | null, fallbackY: number): number {
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
}): Float32Array {
  const { enabled, gridEnabled, gridSectionClip, fallbackY = 0 } = params;
  const effectiveGridEnabled = gridEnabled ?? enabled;
  const stores = useActiveStores();
  const hiddenSets = useHiddenOwnerSets();
  // Trigger parse if EITHER subset is enabled — the parse pass is shared.
  const version = useAnnotationParseTrigger(enabled || effectiveGridEnabled, stores);
  const clipEnabled = !!gridSectionClip && gridSectionClip.enabled && gridSectionClip.axis === 'down';
  const clipPos = clipEnabled ? gridSectionClip!.posWorld : 0;
  const clipDepth = clipEnabled ? gridSectionClip!.viewDepth : 0;

  return useMemo(() => {
    if (!enabled && !effectiveGridEnabled) return EMPTY_F32;
    void version; // depend on parse-completion ticks

    const verts: number[] = [];
    let storeIdx = 0;
    for (const entry of stores) {
      const key = sourceKey(entry.store);
      if (!key) { storeIdx++; continue; }
      const cached = PARSE_CACHE.get(key);
      if (!cached) {
        if (debugEnabled()) console.log(`[annotations] store ${storeIdx}: parse not yet ready for key=${key}`);
        storeIdx++;
        continue;
      }
      // Per-entity hide: an annotation/grid owner hidden via the hierarchy,
      // a lens, or a federated per-model hide drops its overlay primitives.
      const isHidden = makeHiddenOwnerPredicate(entry, hiddenSets);
      if (debugEnabled()) {
        console.log(
          `[annotations] store ${storeIdx}: annotation buckets=${cached.byStorey.size}+${cached.loose.length}loose, grid buckets=${cached.gridByStorey.size}+${cached.gridLoose.length}loose (annot=${enabled}, grid=${effectiveGridEnabled}, clip=${clipEnabled})`,
        );
      }

      if (enabled) {
        for (const bucket of cached.byStorey.values()) {
          liftTo3DLineList(bucket.lines, resolveBucketY(bucket.storeyElevation, fallbackY), verts, isHidden);
        }
        liftTo3DLineList(cached.loose, fallbackY, verts, isHidden);
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
            liftTo3DLineList(bucket.lines, y, verts, isHidden);
          }
          if (fallbackY >= lo && fallbackY <= hi) {
            liftTo3DLineList(cached.gridLoose, fallbackY, verts, isHidden);
          }
        } else {
          for (const bucket of cached.gridByStorey.values()) {
            liftTo3DLineList(bucket.lines, resolveBucketY(bucket.storeyElevation, fallbackY), verts, isHidden);
          }
          liftTo3DLineList(cached.gridLoose, fallbackY, verts, isHidden);
        }
      }
      storeIdx++;
    }

    if (debugEnabled()) console.log(`[annotations] total 3D line vertices: ${verts.length / 3} from ${stores.length} stores`);
    if (verts.length === 0) return EMPTY_F32;
    return new Float32Array(verts);
  }, [enabled, effectiveGridEnabled, clipEnabled, clipPos, clipDepth, stores, hiddenSets, version, fallbackY]);
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
}

/** Cheap stable empty arrays for the no-data path. */
const EMPTY_TEXTS: readonly AnnotationText3D[] = Object.freeze([]);
const EMPTY_FILLS: readonly AnnotationFill3D[] = Object.freeze([]);

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
      const key = sourceKey(entry.store);
      if (!key) continue;
      const cached = PARSE_CACHE.get(key);
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
}): { texts: readonly AnnotationText3D[]; fills: readonly AnnotationFill3D[] } {
  const { enabled, gridEnabled, gridSectionClip, fallbackY = 0 } = params;
  const effectiveGridEnabled = gridEnabled ?? enabled;
  const stores = useActiveStores();
  const hiddenSets = useHiddenOwnerSets();
  const version = useAnnotationParseTrigger(enabled || effectiveGridEnabled, stores);
  const clipEnabled = !!gridSectionClip && gridSectionClip.enabled && gridSectionClip.axis === 'down';
  const clipPos = clipEnabled ? gridSectionClip!.posWorld : 0;
  const clipDepth = clipEnabled ? gridSectionClip!.viewDepth : 0;

  return useMemo(() => {
    if (!enabled && !effectiveGridEnabled) return { texts: EMPTY_TEXTS, fills: EMPTY_FILLS };
    void version;

    const texts: AnnotationText3D[] = [];
    const fills: AnnotationFill3D[] = [];

    for (const entry of stores) {
      const key = sourceKey(entry.store);
      if (!key) continue;
      const cached = PARSE_CACHE.get(key);
      if (!cached) continue;

      // Per-entity hide: drop text/fills whose owning annotation is hidden.
      const isHidden = makeHiddenOwnerPredicate(entry, hiddenSets);

      const pushText = (t: AnnotationText2D, y: number) => {
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
        });
      };
      const pushFill = (f: AnnotationFill2D, y: number) => {
        if (isHidden && isHidden(f.ownerId)) return;
        fills.push({
          points: f.points,
          holesOffsets: f.holesOffsets,
          worldY: y,
          color: f.color,
          hatching: f.hatching,
        });
      };

      if (enabled) {
        for (const bucket of cached.byStorey.values()) {
          const y = resolveBucketY(bucket.storeyElevation, fallbackY);
          for (const t of bucket.texts) pushText(t, y);
          for (const f of bucket.fills) pushFill(f, y);
        }
        for (const t of cached.looseTexts) pushText(t, fallbackY);
        for (const f of cached.looseFills) pushFill(f, fallbackY);
      }

      if (effectiveGridEnabled) {
        if (clipEnabled) {
          const lo = clipPos - clipDepth;
          const hi = clipPos + clipDepth;
          for (const bucket of cached.gridByStorey.values()) {
            const y = resolveBucketY(bucket.storeyElevation, fallbackY);
            if (y < lo || y > hi) continue;
            for (const t of bucket.texts) pushText(t, y);
            for (const f of bucket.fills) pushFill(f, y);
          }
          if (fallbackY >= lo && fallbackY <= hi) {
            for (const t of cached.gridLooseTexts) pushText(t, fallbackY);
            for (const f of cached.gridLooseFills) pushFill(f, fallbackY);
          }
        } else {
          for (const bucket of cached.gridByStorey.values()) {
            const y = resolveBucketY(bucket.storeyElevation, fallbackY);
            for (const t of bucket.texts) pushText(t, y);
            for (const f of bucket.fills) pushFill(f, y);
          }
          for (const t of cached.gridLooseTexts) pushText(t, fallbackY);
          for (const f of cached.gridLooseFills) pushFill(f, fallbackY);
        }
      }
    }

    return {
      texts: texts.length ? texts : EMPTY_TEXTS,
      fills: fills.length ? fills : EMPTY_FILLS,
    };
  }, [enabled, effectiveGridEnabled, clipEnabled, clipPos, clipDepth, stores, hiddenSets, version, fallbackY]);
}
