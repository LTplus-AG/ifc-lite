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
import { GeometryProcessor } from '@ifc-lite/geometry';
import type { DrawingLine2D } from '@ifc-lite/renderer';
import { decodeIfcString } from '@ifc-lite/encoding';
import { useViewerStore } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import type { IfcDataStore } from '@ifc-lite/parser';

/** Lines belonging to a single storey, ready to feed into the section overlay. */
export interface AnnotationsForStorey {
  storeyId: number;
  /** Authored `IfcBuildingStorey.Elevation`. `null` means the storey carried
   *  no elevation in the parsed metadata — distinguishing that from a real
   *  ground-floor at 0.0 matters because `resolveBucketY` only wants to swap
   *  in the fallback in the missing case, not for legitimate ground floors. */
  storeyElevation: number | null;
  lines: DrawingLine2D[];
  texts: AnnotationText2D[];
  fills: AnnotationFill2D[];
}

/**
 * A single text label in renderer 2D space (XZ on the section plane).
 *
 * `dirX / dirY` encodes the baseline direction (already mirrored to match the
 * Y-negated 2D coord system that lines and circles use). `height` is in world
 * units. `alignment` is the raw IFC `BoxAlignment` string ("bottom-left",
 * "center", …) — the renderer interprets it.
 */
export interface AnnotationText2D {
  x: number;
  y: number;
  dirX: number;
  dirY: number;
  height: number;
  content: string;
  alignment: string;
  /**
   * For multi-line text literals (e.g. CJK descriptions with `\X\0A`
   * newlines), one IfcTextLiteralWithExtent expands into one AnnotationText2D
   * per line. `lineYOffset` is added to the storey-elevation world-Y at 3D
   * conversion so successive lines stack downward (negative Y) below the
   * shared anchor. Optional — single-line literals leave it undefined.
   */
  lineYOffset?: number;
}

/**
 * A single filled region in renderer 2D space. Outer ring + holes flattened
 * into one `points` array; `holesOffsets` marks where each hole starts (in
 * vertex indices, not floats). Empty `holesOffsets` = simple polygon.
 *
 * `hatching` is present when the IFC style chain resolved to an
 * IfcFillAreaStyleHatching. When absent the fill is solid (color only).
 */
export interface AnnotationFill2D {
  points: Float32Array;
  holesOffsets: Uint32Array;
  color: [number, number, number, number];
  hatching?: {
    spacing: number;
    angle: number;
    angleSecondary: number | null;
    lineWidth: number;
  };
}

/** Cached parse result keyed by source identity. */
interface ParseResult {
  byStorey: Map<number, AnnotationsForStorey>;
  /** Annotations with no resolvable storey — shown on every floor as a fallback. */
  loose: DrawingLine2D[];
  looseTexts: AnnotationText2D[];
  looseFills: AnnotationFill2D[];
}

const CIRCLE_SEGMENTS_FULL = 32;
const CIRCLE_SEGMENTS_ARC = 16;

/**
 * Convert a polyline (Float32Array of [x,y,x,y,…]) into start/end segments.
 * Exported for unit testing.
 */
export function polylineToSegments(
  points: Float32Array,
  pointCount: number,
  isClosed: boolean,
  out: DrawingLine2D[],
): void {
  for (let j = 0; j < pointCount - 1; j++) {
    out.push({
      line: {
        start: { x: points[j * 2], y: points[j * 2 + 1] },
        end:   { x: points[(j + 1) * 2], y: points[(j + 1) * 2 + 1] },
      },
      category: 'annotation',
    });
  }
  if (isClosed && pointCount > 2) {
    out.push({
      line: {
        start: { x: points[(pointCount - 1) * 2], y: points[(pointCount - 1) * 2 + 1] },
        end:   { x: points[0], y: points[1] },
      },
      category: 'annotation',
    });
  }
}

/**
 * Tessellate a circle/arc into chord segments.
 * Exported for unit testing.
 */
export function circleToSegments(
  centerX: number,
  centerY: number,
  radius: number,
  startAngle: number,
  endAngle: number,
  isFullCircle: boolean,
  out: DrawingLine2D[],
): void {
  const numSegments = isFullCircle ? CIRCLE_SEGMENTS_FULL : CIRCLE_SEGMENTS_ARC;
  for (let j = 0; j < numSegments; j++) {
    const t1 = j / numSegments;
    const t2 = (j + 1) / numSegments;
    const a1 = startAngle + t1 * (endAngle - startAngle);
    const a2 = startAngle + t2 * (endAngle - startAngle);
    out.push({
      line: {
        start: { x: centerX + radius * Math.cos(a1), y: centerY + radius * Math.sin(a1) },
        end:   { x: centerX + radius * Math.cos(a2), y: centerY + radius * Math.sin(a2) },
      },
      category: 'annotation',
    });
  }
}

/** Make a stable cache key for one parsed source.
 *
 * Uses byteLength + a sample of the actual bytes (head, middle, tail) so two
 * different IFC sources can't alias even when they happen to share an exact
 * size — a real risk in federated views with multiple loaded models, and the
 * symptom is that the second model's annotations get hidden because the parse
 * effect skips it as "already cached". Sampling 96 bytes is cheap, doesn't
 * read the whole file, and is collision-resistant in practice. The buffer
 * identity is also folded in so the same content loaded twice from two
 * different ArrayBuffers (rare but possible) keeps distinct entries.
 */
function sourceKey(store: IfcDataStore | null | undefined): string | null {
  const source = store?.source;
  if (!source || source.byteLength === 0) return null;
  const len = source.byteLength;
  const sampleLen = Math.min(32, len);
  const head = source.subarray(0, sampleLen);
  const tail = source.subarray(len - sampleLen, len);
  const midOffset = Math.max(0, Math.floor(len / 2) - Math.floor(sampleLen / 2));
  const mid = source.subarray(midOffset, Math.min(midOffset + sampleLen, len));
  // Fold each window into a 32-bit FNV-1a; cheap and collision-resistant for
  // 96 bytes of structurally distinct IFC headers/body/footer.
  const hashOne = (bytes: Uint8Array): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  };
  return `b${len}-${hashOne(head)}-${hashOne(mid)}-${hashOne(tail)}`;
}

/** Set `localStorage.IFC_ANNOTATIONS_DEBUG = '1'` in the browser to log
 *  per-store parse counts + lift vertex counts to the console. Off by
 *  default; useful when triaging "no annotations visible" reports. */
const debugEnabled = (): boolean => {
  if (typeof window === 'undefined') return false;
  try { return window.localStorage?.getItem('IFC_ANNOTATIONS_DEBUG') === '1'; }
  catch { return false; }
};

async function parseAnnotations(
  store: IfcDataStore,
): Promise<ParseResult> {
  const result: ParseResult = {
    byStorey: new Map(),
    loose: [],
    looseTexts: [],
    looseFills: [],
  };
  const source = store.source;
  if (!source || source.byteLength === 0) {
    if (debugEnabled()) console.log('[annotations] skip: missing/empty source');
    return result;
  }

  const hierarchy = store.spatialHierarchy;
  const elementToStorey = hierarchy?.elementToStorey;
  const storeyElevations = hierarchy?.storeyElevations;

  const processor = new GeometryProcessor();
  try {
    await processor.init();
    const collection = processor.parseSymbolicRepresentations(source);
    if (debugEnabled()) {
      console.log(
        `[annotations] parsed ${source.byteLength} bytes →`,
        collection
          ? `${collection.polylineCount} polylines, ${collection.circleCount} circles, ${collection.textCount} texts, ${collection.fillCount} fills`
          : 'null',
      );
    }
    if (!collection || collection.isEmpty) return result;

    // Get or create the per-storey bucket for an annotation. Storey lookup
    // can fail (no spatial hierarchy entry), in which case the caller falls
    // through to the looseLines / looseTexts / looseFills bucket via the
    // returned `null`. Two-tier API keeps `bucketFor(...).lines.push(...)`
    // readable at call sites.
    const ensureBucket = (expressId: number): AnnotationsForStorey | null => {
      const storeyId = elementToStorey?.get(expressId);
      if (storeyId === undefined) return null;
      let bucket = result.byStorey.get(storeyId);
      if (!bucket) {
        const elev = storeyElevations?.get(storeyId);
        bucket = {
          storeyId,
          storeyElevation: typeof elev === 'number' && Number.isFinite(elev) ? elev : null,
          lines: [],
          texts: [],
          fills: [],
        };
        result.byStorey.set(storeyId, bucket);
      }
      return bucket;
    };

    for (let i = 0; i < collection.polylineCount; i++) {
      const poly = collection.getPolyline(i);
      if (!poly) continue;
      if (poly.ifcType !== 'IfcAnnotation' && poly.ifcType !== 'IfcGridAxis') continue;
      const bucket = ensureBucket(poly.expressId);
      const out = bucket ? bucket.lines : result.loose;
      polylineToSegments(poly.points, poly.pointCount, poly.isClosed, out);
    }

    for (let i = 0; i < collection.circleCount; i++) {
      const circle = collection.getCircle(i);
      if (!circle) continue;
      if (circle.ifcType !== 'IfcAnnotation' && circle.ifcType !== 'IfcGridAxis') continue;
      const bucket = ensureBucket(circle.expressId);
      const out = bucket ? bucket.lines : result.loose;
      circleToSegments(
        circle.centerX,
        circle.centerY,
        circle.radius,
        circle.startAngle,
        circle.endAngle,
        circle.isFullCircle,
        out,
      );
    }

    for (let i = 0; i < collection.textCount; i++) {
      const text = collection.getText(i);
      if (!text) continue;
      if (text.ifcType !== 'IfcAnnotation' && text.ifcType !== 'IfcGridAxis') continue;
      // Skip empty literals so the renderer doesn't waste an instance slot.
      // Decode STEP escapes — `\X2\NNNN\X0\` (UTF-16 hex code units) and
      // `\X\NN` (Latin-1 hex byte). The Rust parser intentionally passes
      // the literal through verbatim; this is where the JS encoding
      // package gets applied. Without it, non-ASCII annotation labels
      // (e.g. CJK content) render as raw escape sequences in the atlas.
      const decoded = decodeIfcString(text.content);
      if (decoded.length === 0) continue;

      // Multi-line split: IfcTextLiteralWithExtent.SizeInY is the LAYOUT BOX
      // height, not the glyph cap height. The Rust extractor multiplies
      // SizeInY × 0.7 to recover a single-line cap; for multi-line literals
      // we further divide by line count and stack lines downward in world-Y.
      // Source: IFC4 spec — IfcPlanarExtent describes the bounding box of
      // the typeset string; one literal per line is the conventional
      // rendering model (matches BIMvision / Solibri / Revit).
      const lines = decoded.split(/\r?\n/).filter((l) => l.length > 0);
      if (lines.length === 0) continue;
      const perLineHeight = lines.length > 1 ? text.height / lines.length : text.height;
      // Industry-standard line-spacing (CSS line-height ≈ 1.2). Picks up
      // a little air between rows so descenders don't kiss the next cap.
      const lineSpacing = perLineHeight * 1.2;
      const bucket = ensureBucket(text.expressId);
      for (let li = 0; li < lines.length; li++) {
        const t2d: AnnotationText2D = {
          x: text.x,
          y: text.y,
          dirX: text.dirX,
          dirY: text.dirY,
          height: perLineHeight,
          content: lines[li],
          alignment: text.alignment,
          lineYOffset: -li * lineSpacing,
        };
        (bucket ? bucket.texts : result.looseTexts).push(t2d);
      }
    }

    for (let i = 0; i < collection.fillCount; i++) {
      const fill = collection.getFill(i);
      if (!fill) continue;
      if (fill.ifcType !== 'IfcAnnotation' && fill.ifcType !== 'IfcGridAxis') continue;
      const points = fill.points;
      if (points.length < 6) continue; // <3 vertices = no polygon
      const f2d: AnnotationFill2D = {
        points,
        holesOffsets: fill.holesOffsets,
        color: [fill.fillR, fill.fillG, fill.fillB, fill.fillA],
        hatching: fill.hasHatching
          ? {
              spacing: fill.hatchSpacing,
              angle: fill.hatchAngle,
              angleSecondary: Number.isNaN(fill.hatchAngleSecondary) ? null : fill.hatchAngleSecondary,
              lineWidth: fill.hatchLineWidth,
            }
          : undefined,
      };
      const bucket = ensureBucket(fill.expressId);
      (bucket ? bucket.fills : result.looseFills).push(f2d);
    }
  } finally {
    processor.dispose();
  }

  return result;
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
): void {
  for (const line of lines) {
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

function ensureParseFor(stores: IfcDataStore[]): void {
  for (const store of stores) {
    const key = sourceKey(store);
    if (!key) continue;
    if (PARSE_CACHE.has(key)) continue;
    if (PARSE_INFLIGHT.has(key)) continue;

    const promise = (async () => {
      try {
        const result = await parseAnnotations(store);
        PARSE_CACHE.set(key, result);
        notifyCacheChange();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[useSymbolicAnnotations] parse failed:', error);
      } finally {
        PARSE_INFLIGHT.delete(key);
      }
    })();
    PARSE_INFLIGHT.set(key, promise);
  }
}

/** Read the active store set from the viewer store. Federation-aware. */
function useActiveStores(): IfcDataStore[] {
  const { models, ifcDataStore } = useViewerStore(
    useShallow((s) => ({ models: s.models, ifcDataStore: s.ifcDataStore })),
  );
  return useMemo(() => {
    const out: IfcDataStore[] = [];
    if (models.size > 0) {
      for (const [, m] of models) if (m.ifcDataStore) out.push(m.ifcDataStore);
    } else if (ifcDataStore) {
      out.push(ifcDataStore);
    }
    return out;
  }, [models, ifcDataStore]);
}

/** Trigger parse for the active stores when `enabled`, tick on completion. */
function useAnnotationParseTrigger(enabled: boolean, stores: IfcDataStore[]): number {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    ensureParseFor(stores);
    const listener: CacheListener = () => setVersion((v) => v + 1);
    CACHE_LISTENERS.add(listener);
    return () => {
      CACHE_LISTENERS.delete(listener);
    };
  }, [enabled, stores]);

  return version;
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

export function useSymbolicAnnotations(params: {
  enabled: boolean;
  /** World Y to use for annotations with no resolvable storey. Defaults to 0. */
  fallbackY?: number;
}): Float32Array {
  const { enabled, fallbackY = 0 } = params;
  const stores = useActiveStores();
  const version = useAnnotationParseTrigger(enabled, stores);

  return useMemo(() => {
    if (!enabled) return EMPTY_F32;
    void version; // depend on parse-completion ticks

    const verts: number[] = [];
    let storeIdx = 0;
    for (const store of stores) {
      const key = sourceKey(store);
      if (!key) { storeIdx++; continue; }
      const cached = PARSE_CACHE.get(key);
      if (!cached) {
        if (debugEnabled()) console.log(`[annotations] store ${storeIdx}: parse not yet ready for key=${key}`);
        storeIdx++;
        continue;
      }
      if (debugEnabled()) {
        const buckets = cached.byStorey.size;
        const looseLines = cached.loose.length;
        console.log(`[annotations] store ${storeIdx}: lifting ${buckets} storey buckets + ${looseLines} loose lines (key=${key}, fallbackY=${fallbackY})`);
      }

      for (const bucket of cached.byStorey.values()) {
        liftTo3DLineList(bucket.lines, resolveBucketY(bucket.storeyElevation, fallbackY), verts);
      }
      liftTo3DLineList(cached.loose, fallbackY, verts);
      storeIdx++;
    }

    if (debugEnabled()) console.log(`[annotations] total 3D line vertices: ${verts.length / 3} from ${stores.length} stores`);
    if (verts.length === 0) return EMPTY_F32;
    return new Float32Array(verts);
  }, [enabled, stores, version, fallbackY]);
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
 * Hook for the WebGPU text + fill pipelines. Returns 3D-lifted texts and
 * fills for every active model. Shares the parse cache with
 * `useSymbolicAnnotations` so toggling on text+fill rendering after the
 * line overlay is already up costs no extra parse work.
 */
export function useSymbolicAnnotationsRichData(params: {
  enabled: boolean;
  fallbackY?: number;
}): { texts: readonly AnnotationText3D[]; fills: readonly AnnotationFill3D[] } {
  const { enabled, fallbackY = 0 } = params;
  const stores = useActiveStores();
  const version = useAnnotationParseTrigger(enabled, stores);

  return useMemo(() => {
    if (!enabled) return { texts: EMPTY_TEXTS, fills: EMPTY_FILLS };
    void version;

    const texts: AnnotationText3D[] = [];
    const fills: AnnotationFill3D[] = [];

    for (const store of stores) {
      const key = sourceKey(store);
      if (!key) continue;
      const cached = PARSE_CACHE.get(key);
      if (!cached) continue;

      const pushText = (t: AnnotationText2D, y: number) => {
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
        });
      };
      const pushFill = (f: AnnotationFill2D, y: number) => {
        fills.push({
          points: f.points,
          holesOffsets: f.holesOffsets,
          worldY: y,
          color: f.color,
          hatching: f.hatching,
        });
      };

      for (const bucket of cached.byStorey.values()) {
        const y = resolveBucketY(bucket.storeyElevation, fallbackY);
        for (const t of bucket.texts) pushText(t, y);
        for (const f of bucket.fills) pushFill(f, y);
      }
      for (const t of cached.looseTexts) pushText(t, fallbackY);
      for (const f of cached.looseFills) pushFill(f, fallbackY);
    }

    return {
      texts: texts.length ? texts : EMPTY_TEXTS,
      fills: fills.length ? fills : EMPTY_FILLS,
    };
  }, [enabled, stores, version, fallbackY]);
}
