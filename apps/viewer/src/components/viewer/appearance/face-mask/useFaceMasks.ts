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

/**
 * Session face masks of the appearance workspace (#4404): one reviewed
 * selection per converted product, bound to the planner's surface fingerprint.
 * Masks never persist to IFC; they clear when the target model changes or
 * reloads, when the product is applied (its Body is direct tessellation from
 * then on), and when the planner reports the surface stale.
 */
export function useFaceMasks(modelId: string | null) {
  const modelKey = useViewerStore(state => modelId ? `${modelId}:${state.models.get(modelId)?.loadedAt ?? 'removed'}` : null);
  const [masks, setMasks] = useState<FaceMasks>(new Map());
  const [diagnostics, setDiagnostics] = useState<readonly string[]>([]);
  const [conversions, setConversions] = useState<{ modelId: string; items: readonly Conversion[] } | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const current = useRef(masks); current.current = masks;
  useEffect(() => { setMasks(new Map()); setDiagnostics([]); setConversions(null); setEditing(null); }, [modelKey]);

  const requests = useCallback((productIds: readonly number[]) => faceMaskRequests(current.current, productIds), []);
  /** Adopt the planner's verdicts: drop stale masks with a diagnostic, remember the converted surfaces for editing. */
  const reconcile = useCallback((plan: AppearancePlan, targetModelId: string, label: (productId: number) => string) => {
    const result = reconcileFaceMasks(current.current, plan, label);
    if (result.masks !== current.current) { current.current = result.masks; setMasks(result.masks); }
    if (result.diagnostics.length) setDiagnostics(previous => [...previous, ...result.diagnostics]);
    if (plan.conversions?.length) setConversions({ modelId: targetModelId, items: plan.conversions });
    return result;
  }, []);
  const change = useCallback((productId: number, triangles: Iterable<number> | null) => {
    const conversion = conversions?.items.find(item => item.productId === productId);
    setDiagnostics([]);
    setMasks(previous => {
      const next = new Map(previous);
      const count = conversion ? conversion.sourceIndices.length / 3 : 0;
      const normalized = triangles === null || !conversion?.surfaceFingerprint ? new Uint32Array() : normalizeFaceTriangles(triangles, count);
      if (!normalized.length || normalized.length >= count) next.delete(productId);
      else next.set(productId, { productId, surfaceFingerprint: conversion!.surfaceFingerprint!, triangles: normalized } satisfies FaceMask);
      current.current = next;
      return next;
    });
  }, [conversions]);
  /** Applied products carry a direct tessellated Body from now on; their selections are spent. */
  const clearApplied = useCallback((productIds: readonly number[]) => {
    setMasks(previous => {
      if (!productIds.some(id => previous.has(id))) return previous;
      const next = new Map(previous);
      for (const id of productIds) next.delete(id);
      current.current = next;
      return next;
    });
    setConversions(null); setEditing(null);
  }, []);
  const reset = useCallback(() => { setConversions(null); setEditing(null); }, []);
  const targets = useMemo<FaceMaskTarget[]>(() => {
    if (!conversions || conversions.modelId !== modelId) return [];
    const state = useViewerStore.getState();
    return conversions.items.flatMap(conversion => {
      if (!conversion.surfaceFingerprint || conversion.sourcePositions === undefined) return [];
      try {
        const mesh = { ...occurrenceSourceMesh(state, conversions.modelId, conversion), color: [...SELECTED_FACE_COLOR] as MeshData['color'] };
        return [{ productId: conversion.productId, label: `IFC object #${conversion.productId}`, triangleCount: conversion.sourceIndices.length / 3,
          selected: masks.get(conversion.productId)?.triangles, mesh }];
      } catch (error) {
        console.warn('[Appearance] face selection surface unavailable', error);
        return [];
      }
    });
  }, [conversions, masks, modelId]);
  const controls = useMemo<FaceMaskControls>(() => ({ targets, diagnostics, editing, onEdit: setEditing, onChange: change }), [targets, diagnostics, editing, change]);
  return { masks, requests, reconcile, clearApplied, reset, controls };
}
