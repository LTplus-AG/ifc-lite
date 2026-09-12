/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { faceMaskRequests, normalizeFaceTriangles, reconcileFaceMasks, type FaceMask, type FaceMasks } from '@/lib/appearance/face-masks.js';
import { occurrenceSourceMesh } from '@/lib/appearance/occurrence-source-mesh.js';
import type { AppearancePlan } from '@/lib/appearance/planner-types.js';

type Conversion = NonNullable<AppearancePlan['conversions']>[number];
/** Highlight and dim colours of the face-selection canvas (renderer RGBA). */
export const SELECTED_FACE_COLOR: readonly [number, number, number, number] = [0.98, 0.62, 0.11, 1];
export const UNSELECTED_FACE_COLOR: readonly [number, number, number, number] = [0.72, 0.72, 0.72, 1];

export interface FaceMaskTarget {
  productId: number;
  label: string;
  triangleCount: number;
  /** Ascending selected ordinals; `undefined` textures the whole surface. */
  selected?: Uint32Array;
  /** The evaluated source surface in the renderer frame, for the selection canvas. */
  mesh: MeshData;
}
export interface FaceMaskControls {
  targets: readonly FaceMaskTarget[];
  diagnostics: readonly string[];
  editing: number | null;
  onEdit(productId: number | null): void;
  onChange(productId: number, triangles: Iterable<number> | null): void;
}
interface Surface { productId: number; fingerprint: string; triangleCount: number; mesh: MeshData }

const sameArray = (a: ArrayLike<number> | undefined, b: ArrayLike<number> | undefined) =>
  a === b || (!!a && !!b && a.length === b.length && Array.prototype.every.call(a, (value: number, i: number) => value === b[i]));

/**
 * The editor's canvas owns a renderer whose lifetime follows the `mesh`
 * identity, so a re-plan that reproduces the same surface (same fingerprint,
 * same placed corners) must hand back the previous object, not an equal copy.
 */
function stableSurface(previous: Surface | undefined, conversion: Conversion, modelId: string): Surface {
  const fingerprint = conversion.surfaceFingerprint!;
  const mesh = { ...occurrenceSourceMesh(useViewerStore.getState(), modelId, conversion), color: [...SELECTED_FACE_COLOR] as MeshData['color'] };
  if (previous && previous.fingerprint === fingerprint && sameArray(previous.mesh.positions, mesh.positions)
    && sameArray(previous.mesh.indices, mesh.indices) && sameArray(previous.mesh.origin, mesh.origin)) return previous;
  return { productId: conversion.productId, fingerprint, triangleCount: conversion.sourceIndices.length / 3, mesh };
}

/**
 * Session face masks of the appearance workspace (#4404): one reviewed
 * selection per converted product, bound to the planner's surface fingerprint.
 * Masks never persist to IFC; they clear when the target model changes or
 * reloads, when the product is applied (its Body is direct tessellation from
 * then on), and when the planner reports the surface stale. Under a policy
 * other than `evaluatedOccurrence` they stay dormant in the session; the host
 * decides which requests carry them.
 */
export function useFaceMasks(modelId: string | null) {
  const modelKey = useViewerStore(state => modelId ? `${modelId}:${state.models.get(modelId)?.loadedAt ?? 'removed'}` : null);
  const [masks, setMasks] = useState<FaceMasks>(new Map());
  const [diagnostics, setDiagnostics] = useState<readonly string[]>([]);
  const [conversions, setConversions] = useState<{ modelId: string; items: readonly Conversion[] } | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  // The latest map for callbacks that run between renders (requests, reconcile).
  const current = useRef(masks);
  const surfaces = useRef(new Map<number, Surface>());
  const commit = useCallback((next: FaceMasks) => { if (next !== current.current) { current.current = next; setMasks(next); } }, []);
  useEffect(() => { commit(new Map()); setDiagnostics([]); setConversions(null); setEditing(null); surfaces.current.clear(); }, [modelKey, commit]);

  const requests = useCallback((productIds: readonly number[]) => faceMaskRequests(current.current, productIds), []);
  /** Adopt the planner's verdicts: drop stale masks with a diagnostic, remember the converted surfaces for editing. */
  const reconcile = useCallback((plan: AppearancePlan, targetModelId: string, label: (productId: number) => string) => {
    const result = reconcileFaceMasks(current.current, plan, label);
    commit(result.masks);
    // A dropped selection's diagnostic stays through the automatic re-plan
    // that follows it; a selection change, Discard or Apply clears it.
    if (result.diagnostics.length) setDiagnostics(result.diagnostics);
    setConversions(plan.conversions?.length ? { modelId: targetModelId, items: plan.conversions } : null);
    return result;
  }, [commit]);
  const change = useCallback((productId: number, triangles: Iterable<number> | null) => {
    const conversion = conversions?.items.find(item => item.productId === productId);
    setDiagnostics([]);
    const next = new Map(current.current);
    const count = conversion ? conversion.sourceIndices.length / 3 : 0;
    const normalized = triangles === null || !conversion?.surfaceFingerprint ? new Uint32Array() : normalizeFaceTriangles(triangles, count);
    if (!normalized.length || normalized.length >= count) next.delete(productId);
    else next.set(productId, { productId, surfaceFingerprint: conversion!.surfaceFingerprint!, triangles: normalized } satisfies FaceMask);
    commit(next);
  }, [conversions, commit]);
  /** Applied products carry a direct tessellated Body from now on; their selections are spent. */
  const clearApplied = useCallback((productIds: readonly number[]) => {
    if (productIds.some(id => current.current.has(id))) {
      const next = new Map(current.current);
      for (const id of productIds) next.delete(id);
      commit(next);
    }
    setDiagnostics([]); setConversions(null); setEditing(null);
  }, [commit]);
  /** The workspace left the preview (Discard, another intent, no model): keep the selections, close the editor. */
  const reset = useCallback(() => { setDiagnostics([]); setConversions(null); setEditing(null); }, []);
  const editable = useMemo<Surface[]>(() => {
    if (!conversions || conversions.modelId !== modelId) return [];
    const cache = surfaces.current, live = new Map<number, Surface>();
    for (const conversion of conversions.items) {
      if (!conversion.surfaceFingerprint || conversion.sourcePositions === undefined) continue;
      try { live.set(conversion.productId, stableSurface(cache.get(conversion.productId), conversion, conversions.modelId)); }
      catch (error) { console.warn('[Appearance] face selection surface unavailable', error); }
    }
    surfaces.current = live;
    return [...live.values()];
  }, [conversions, modelId]);
  const targets = useMemo<FaceMaskTarget[]>(() => editable.map(surface => ({ productId: surface.productId, label: `IFC object #${surface.productId}`,
    triangleCount: surface.triangleCount, selected: masks.get(surface.productId)?.triangles, mesh: surface.mesh })), [editable, masks]);
  const controls = useMemo<FaceMaskControls>(() => ({ targets, diagnostics, editing, onEdit: setEditing, onChange: change }), [targets, diagnostics, editing, change]);
  return { masks, requests, reconcile, clearApplied, reset, controls };
}
