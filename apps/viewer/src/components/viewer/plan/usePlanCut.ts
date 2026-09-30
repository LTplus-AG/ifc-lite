/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one plan-cut path (charter #6232, M2 §1.5): `Drawing2DGenerator` over
 * the model meshes, cut horizontally 1.2 m above a storey floor, mapped into
 * whatever 2D frame the caller draws in. The Model workspace's plan pane
 * (`usePlanCut`, workplane-local metres) runs on it.
 *
 * A cut is keyed by the caller (storey, geometry and mutation versions),
 * debounced 150 ms so a burst of edits costs one generation, and superseded
 * results are dropped. Above `meshLimit` meshes nothing is generated and the
 * result says `simplified`: the plan then draws wall axes only, because the
 * CPU cut runs on the main thread and grows with the whole model's triangles.
 *
 * Frames. For a 'y' (plan) cut `projectTo2D` yields (vertex x, vertex z) of
 * the render-frame vertices. Vertices are in the model's own render frame;
 * the model's reposition placement is applied on top by the renderer, so a
 * plan point goes vertex frame → workspace (`modelPointToWorkspacePoint`) →
 * workplane-local (`Workplane.renderToLocal`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Drawing2DGenerator, createSectionConfig, type Drawing2D } from '@ifc-lite/drawing-2d';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { selectModelMeshes } from '@/lib/type-view-visibility';
import type { Vec2 } from '@/lib/snap/types';
import type { Workplane } from '@/lib/commands/modeling/types';
import { displayedTranslation, placementFor, type PlacementState } from '@/lib/model-placement/state';
import { modelPointToWorkspacePoint, workspacePointToModelFrame, type PointPlacement } from '@/lib/model-placement/rotation';
import { fromRenderTranslation, toRenderTranslation } from '@/lib/model-placement/translation';

/** Cut height above the storey floor, metres (the architectural plan convention). */
export const PLAN_CUT_HEIGHT = 1.2;
export const PLAN_CUT_DEBOUNCE_MS = 150;
/**
 * Above this many model meshes the plan draws wall axes only. Measured on the
 * CPU cutter in the browser (#6232 M2.4 PR notes): AC20-FZK-Haus (317 meshes)
 * cuts in 26 ms, dental_clinic (4.9k meshes) in 134 ms; the cut grows with
 * the whole model's triangles and runs again after every edit, so the limit
 * sits well below the tens of thousands of meshes of the heavy fixtures.
 */
export const PLAN_CUT_MESH_LIMIT = 8000;

const SECTION_DEPTHS = { projectionDepth: 1.5, projectionBelowDepth: 1.4, projectionAboveDepth: 0.8 } as const;

export interface PlanCutPolygon {
  /** The mesh's express id: the renderer's (global) id. */
  readonly entityId: number;
  readonly ifcType: string;
  readonly outer: readonly Vec2[];
  readonly holes: readonly (readonly Vec2[])[];
}

export interface PlanCutLine {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly entityId: number;
  readonly category: string;
  /** Occluded (drawn dashed), vs visible. */
  readonly hidden: boolean;
}

export interface PlanCutResult {
  readonly polygons: readonly PlanCutPolygon[];
  readonly lines: readonly PlanCutLine[];
  readonly loading: boolean;
  /** The model was over the mesh limit; nothing was cut. */
  readonly simplified: boolean;
  /** Generation time of the last cut, ms (null before the first). */
  readonly ms: number | null;
  /** The result answers the current request (false while a newer one is pending). */
  readonly settled: boolean;
  /**
   * The cutter threw. Distinct from an empty result on purpose: an empty cut
   * reads exactly like a storey with nothing at the cut height.
   */
  readonly failed: boolean;
  /** Run the current request again (after a failure). */
  readonly retry: () => void;
}

export interface PlanCutRequest {
  /** Changes whenever the cut must be regenerated. */
  readonly key: string;
  /**
   * What the cut is OF (model and storey). While a newer cut of the same
   * scope is pending the previous one stays on screen (an edit must not
   * blank the plan); a result of another scope is never shown or picked.
   */
  readonly scope?: string;
  readonly meshes: readonly MeshData[];
  /** The cut plane height in the vertices' render frame (Y-up). */
  readonly cutY: number;
  /** Drawing 2D (vertex x, vertex z) → the caller's frame. */
  readonly map: (x: number, z: number) => Vec2;
  readonly meshLimit?: number;
}

const EMPTY: PlanCutResult = { polygons: [], lines: [], loading: false, simplified: false, ms: null, settled: true, failed: false, retry: () => {} };

/** A result plus the request key it answers. */
type KeyedResult = Omit<PlanCutResult, 'settled' | 'retry'> & { key: string | null; scope?: string };
const EMPTY_KEYED: KeyedResult = { polygons: [], lines: [], loading: false, simplified: false, ms: null, failed: false, key: null };

const identities = new WeakMap<object, number>();
let nextIdentity = 0;
/**
 * A stable number per object, for cut keys: a geometry result is replaced
 * (streamed batches, a re-mesh swapping one element's mesh) without every
 * version counter moving, and the cut must follow it.
 */
export function identityKey(value: object): number {
  let id = identities.get(value);
  if (id === undefined) {
    id = ++nextIdentity;
    identities.set(value, id);
  }
  return id;
}

/** Map a drawing into the caller's frame (pure; exported for tests). */
export function mapPlanDrawing(drawing: Pick<Drawing2D, 'cutPolygons' | 'lines'>, map: PlanCutRequest['map']): Pick<PlanCutResult, 'polygons' | 'lines'> {
  const ring = (pts: readonly { x: number; y: number }[]) => pts.map((p) => map(p.x, p.y));
  return {
    polygons: drawing.cutPolygons.map((p) => ({
      entityId: p.entityId, ifcType: p.ifcType, outer: ring(p.polygon.outer), holes: p.polygon.holes.map(ring),
    })),
    lines: drawing.lines.map((l) => ({
      a: map(l.line.start.x, l.line.start.y),
      b: map(l.line.end.x, l.line.end.y),
      entityId: l.entityId,
      category: l.category,
      hidden: l.visibility === 'hidden',
    })),
  };
}

/** Run the plan cut for `request` (null = nothing to cut). */
export function usePlanCutDrawing(request: PlanCutRequest | null): PlanCutResult {
  const [result, setResult] = useState<KeyedResult>(EMPTY_KEYED);
  const genRef = useRef<Drawing2DGenerator | null>(null);
  const requestRef = useRef(request);
  requestRef.current = request;
  const key = request?.key ?? null;
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const req = requestRef.current;
    if (!req || req.meshes.length === 0) {
      setResult({ ...EMPTY_KEYED, key: req?.key ?? null, scope: req?.scope });
      return;
    }
    if (req.meshLimit !== undefined && req.meshes.length > req.meshLimit) {
      setResult({ ...EMPTY_KEYED, simplified: true, key: req.key, scope: req.scope });
      return;
    }
    let cancelled = false;
    setResult((prev) => ({ ...prev, loading: true, simplified: false, failed: false }));
    const timer = setTimeout(() => {
      void (async () => {
        const started = performance.now();
        try {
          const gen = genRef.current ?? new Drawing2DGenerator();
          genRef.current = gen;
          await gen.initialize();
          if (cancelled) return;
          const drawing = await gen.generate(
            req.meshes as MeshData[],
            createSectionConfig('y', req.cutY, SECTION_DEPTHS),
            { includeProjection: true, includeEdges: false, includeHiddenLines: false, mergeLines: true, useGPU: false },
          );
          if (cancelled) return;
          setResult({ ...mapPlanDrawing(drawing, req.map), loading: false, simplified: false, failed: false, ms: performance.now() - started, key: req.key, scope: req.scope });
        } catch (err) {
          // An empty cut reads exactly like a storey with nothing at the cut,
          // so a failure is its own state (the plan says "Cut failed").
          console.warn('[plan-cut] generation failed', err);
          if (!cancelled) setResult({ ...EMPTY_KEYED, failed: true, key: req.key, scope: req.scope });
        }
      })();
    }, PLAN_CUT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, attempt]);

  if (!request) return EMPTY;
  const { key: answered, scope, ...rest } = result;
  const settled = answered === request.key;
  // Another storey's (or model's) cut is never drawn or picked in this frame.
  if (!settled && scope !== request.scope) return { ...rest, polygons: EMPTY.polygons, lines: EMPTY.lines, failed: false, settled, retry };
  return { ...rest, settled, retry };
}

/** The model placement a plan maps through (the renderer applies it on top of the vertices). */
export function modelPlacementOf(placements: PlacementState, modelId: string): PointPlacement {
  return { translation: displayedTranslation(placements, modelId), rotation: placementFor(placements, modelId).rotation };
}

/**
 * The cut height and the 2D → local map for a storey plan on `plane`. The
 * cut sits `PLAN_CUT_HEIGHT` above the storey floor, whatever the
 * workplane's own offset (`offset` is subtracted back out).
 */
export function planCutFrame(plane: Workplane, placement: PointPlacement, offset: number): { cutY: number; map: PlanCutRequest['map'] } {
  const cut = plane.localToRender([0, 0, PLAN_CUT_HEIGHT - offset]);
  const vertex = toRenderTranslation(workspacePointToModelFrame(fromRenderTranslation({ x: cut[0], y: cut[1], z: cut[2] }), placement));
  const cutY = vertex[1];
  return {
    cutY,
    map: (x, z) => {
      const r = toRenderTranslation(modelPointToWorkspacePoint(fromRenderTranslation({ x, y: cutY, z }), placement));
      const l = plane.renderToLocal(r);
      return [l[0], l[1]];
    },
  };
}

/** The session storey's plan cut, in workplane-local metres. */
export function usePlanCut(modelId: string | null, storeyId: number | null, plane: Workplane | null): PlanCutResult {
  const geometry = useViewerStore((s) => (modelId ? s.models.get(modelId)?.geometryResult ?? null : null));
  const contentVersion = useViewerStore((s) => s.geometryContentVersion);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const placements = useViewerStore((s) => s.modelPlacement);
  const offset = plane?.spec.kind === 'storey' ? plane.spec.offset : 0;

  const request = useMemo<PlanCutRequest | null>(() => {
    if (!modelId || storeyId === null || !plane || !geometry?.meshes) return null;
    const { cutY, map } = planCutFrame(plane, modelPlacementOf(placements, modelId), offset);
    // Building elements only — the type library never belongs in a plan (#2058).
    const meshes = selectModelMeshes(geometry.meshes);
    return {
      scope: `${modelId}:${storeyId}`,
      key: `${modelId}:${storeyId}:${identityKey(geometry)}:${contentVersion}:${mutationVersion}:${meshes.length}:${cutY.toFixed(4)}`,
      meshes,
      cutY,
      map,
      meshLimit: PLAN_CUT_MESH_LIMIT,
    };
  }, [modelId, storeyId, plane, geometry, contentVersion, mutationVersion, placements, offset]);

  return usePlanCutDrawing(request);
}
