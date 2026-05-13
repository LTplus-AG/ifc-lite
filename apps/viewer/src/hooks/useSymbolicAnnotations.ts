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
import { useViewerStore } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import type { IfcDataStore } from '@ifc-lite/parser';

/** Lines belonging to a single storey, ready to feed into the section overlay. */
export interface AnnotationsForStorey {
  storeyId: number;
  storeyElevation: number;
  lines: DrawingLine2D[];
}

/** Cached parse result keyed by source identity. */
interface ParseResult {
  byStorey: Map<number, AnnotationsForStorey>;
  /** Annotations with no resolvable storey — shown on every floor as a fallback. */
  loose: DrawingLine2D[];
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

/** Make a stable cache key for one parsed source. */
function sourceKey(store: IfcDataStore | null | undefined): string | null {
  const source = store?.source;
  if (!source || source.byteLength === 0) return null;
  // byteLength alone is good enough — two distinct files almost never share
  // an exact byte count, and within a session the same buffer keeps its size.
  return `b${source.byteLength}`;
}

async function parseAnnotations(
  store: IfcDataStore,
): Promise<ParseResult> {
  const result: ParseResult = { byStorey: new Map(), loose: [] };
  const source = store.source;
  if (!source || source.byteLength === 0) return result;

  const hierarchy = store.spatialHierarchy;
  const elementToStorey = hierarchy?.elementToStorey;
  const storeyElevations = hierarchy?.storeyElevations;

  const processor = new GeometryProcessor();
  try {
    await processor.init();
    const collection = processor.parseSymbolicRepresentations(source);
    if (!collection || collection.isEmpty) return result;

    const bucketFor = (expressId: number): DrawingLine2D[] => {
      const storeyId = elementToStorey?.get(expressId);
      if (storeyId === undefined) return result.loose;
      let bucket = result.byStorey.get(storeyId);
      if (!bucket) {
        bucket = {
          storeyId,
          storeyElevation: storeyElevations?.get(storeyId) ?? 0,
          lines: [],
        };
        result.byStorey.set(storeyId, bucket);
      }
      return bucket.lines;
    };

    for (let i = 0; i < collection.polylineCount; i++) {
      const poly = collection.getPolyline(i);
      if (!poly) continue;
      if (poly.ifcType !== 'IfcAnnotation') continue;
      polylineToSegments(poly.points, poly.pointCount, poly.isClosed, bucketFor(poly.expressId));
    }

    for (let i = 0; i < collection.circleCount; i++) {
      const circle = collection.getCircle(i);
      if (!circle) continue;
      if (circle.ifcType !== 'IfcAnnotation') continue;
      circleToSegments(
        circle.centerX,
        circle.centerY,
        circle.radius,
        circle.startAngle,
        circle.endAngle,
        circle.isFullCircle,
        bucketFor(circle.expressId),
      );
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

export function useSymbolicAnnotations(params: {
  enabled: boolean;
  /** World Y to use for annotations with no resolvable storey. Defaults to 0. */
  fallbackY?: number;
}): Float32Array {
  const { enabled, fallbackY = 0 } = params;
  const { models, ifcDataStore } = useViewerStore(
    useShallow((s) => ({ models: s.models, ifcDataStore: s.ifcDataStore })),
  );

  // Cache per source key — parsing the whole file's symbolic reps is not
  // cheap (full WASM walk), so we only do it once per model.
  const cacheRef = useRef<Map<string, ParseResult>>(new Map());
  const inflightRef = useRef<Map<string, Promise<void>>>(new Map());
  const [version, setVersion] = useState(0);

  // Trigger parses for any source that doesn't have a cache entry yet.
  // Parsing only happens when the feature is enabled, so toggling off skips
  // the cost entirely on first activation.
  useEffect(() => {
    if (!enabled) return;
    const stores: IfcDataStore[] = [];
    if (models.size > 0) {
      for (const [, m] of models) if (m.ifcDataStore) stores.push(m.ifcDataStore);
    } else if (ifcDataStore) {
      stores.push(ifcDataStore);
    }

    let cancelled = false;
    for (const store of stores) {
      const key = sourceKey(store);
      if (!key) continue;
      if (cacheRef.current.has(key)) continue;
      if (inflightRef.current.has(key)) continue;

      const promise = (async () => {
        try {
          const result = await parseAnnotations(store);
          if (cancelled) return;
          cacheRef.current.set(key, result);
          setVersion((v) => v + 1);
        } catch (error) {
          // Silent — if parsing fails the toggle just shows nothing.
          // eslint-disable-next-line no-console
          console.warn('[useSymbolicAnnotations] parse failed:', error);
        } finally {
          inflightRef.current.delete(key);
        }
      })();
      inflightRef.current.set(key, promise);
    }
    return () => {
      cancelled = true;
    };
  }, [enabled, models, ifcDataStore]);

  return useMemo(() => {
    if (!enabled) return EMPTY_F32;
    void version; // depend on parse-completion ticks

    const stores: IfcDataStore[] = [];
    if (models.size > 0) {
      for (const [, m] of models) if (m.ifcDataStore) stores.push(m.ifcDataStore);
    } else if (ifcDataStore) {
      stores.push(ifcDataStore);
    }

    const verts: number[] = [];
    for (const store of stores) {
      const key = sourceKey(store);
      if (!key) continue;
      const cached = cacheRef.current.get(key);
      if (!cached) continue;

      for (const bucket of cached.byStorey.values()) {
        // Authoring tools sometimes leave `IfcBuildingStorey.Elevation` blank
        // and put the storey Z directly on annotation placements instead.
        // In that case the bucket's recorded elevation is 0 even though the
        // real annotation Y is elsewhere — use the fallback so the overlay
        // remains visible rather than being buried inside the building.
        const y = bucket.storeyElevation === 0 ? fallbackY : bucket.storeyElevation;
        liftTo3DLineList(bucket.lines, y, verts);
      }
      liftTo3DLineList(cached.loose, fallbackY, verts);
    }

    if (verts.length === 0) return EMPTY_F32;
    return new Float32Array(verts);
  }, [enabled, models, ifcDataStore, version, fallbackY]);
}
