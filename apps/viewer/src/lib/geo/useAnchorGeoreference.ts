/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared resolution of the ANCHOR model's effective georeference — the
 * georef that drives the displayed world frame. Federated vertices are
 * re-baked into the anchor frame, so every viewer-space-to-map conversion
 * (Cesium bridge, basepoint overlay, measure geo readout) must use the
 * anchor's MapConversion, never a per-picked-element one.
 *
 * Selection matches `findReferenceGeorefModel` in useIfcFederation: the
 * user-pinned anchor first (falling through when it no longer resolves),
 * then the earliest-loaded model with a usable map georef, then the legacy
 * single-model data store. Unlike the Cesium overlay's memo, this is NOT
 * gated on Cesium/solar being enabled.
 */

import { useMemo } from 'react';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import {
  getEffectiveGeoreference,
  type GeorefMutationDataLike,
} from './effective-georef';
import { hasUsableMapGeoref, type UsableEffectiveGeoref } from './pick-to-geo';

export interface AnchorGeoreference {
  /** Model driving the world frame ('__legacy__' for the single-model path). */
  modelId: string;
  effective: UsableEffectiveGeoref;
  storeyElevations?: Map<number, number>;
}

export interface ResolveAnchorGeoreferenceArgs {
  models: Map<string, FederatedModel>;
  anchorModelIdOverride?: string | null;
  georefMutations: Map<string, GeorefMutationDataLike>;
  /** Legacy single-model fallback (mutations keyed '__legacy__'). */
  legacyDataStore?: IfcDataStore | null;
  legacyCoordinateInfo?: CoordinateInfo;
}

export function resolveAnchorGeoreference({
  models,
  anchorModelIdOverride,
  georefMutations,
  legacyDataStore,
  legacyCoordinateInfo,
}: ResolveAnchorGeoreferenceArgs): AnchorGeoreference | null {
  const tryModel = (modelId: string, model: FederatedModel): AnchorGeoreference | null => {
    const ds = model.ifcDataStore;
    if (!ds) return null;
    const effective = getEffectiveGeoreference(
      ds as IfcDataStore,
      model.geometryResult?.coordinateInfo,
      georefMutations.get(modelId),
    );
    if (!hasUsableMapGeoref(effective)) return null;
    return {
      modelId,
      effective,
      storeyElevations: ds.spatialHierarchy?.storeyElevations,
    };
  };

  // User-pinned anchor first; fall through if it no longer resolves so loads
  // stay recoverable when the pinned anchor was removed or lost its georef.
  if (anchorModelIdOverride) {
    const pinned = models.get(anchorModelIdOverride);
    if (pinned) {
      const resolved = tryModel(anchorModelIdOverride, pinned);
      if (resolved) return resolved;
    }
  }

  const sorted = Array.from(models.entries())
    .sort(([, a], [, b]) => (a.loadedAt ?? 0) - (b.loadedAt ?? 0));
  for (const [modelId, model] of sorted) {
    if (modelId === anchorModelIdOverride) continue;
    const resolved = tryModel(modelId, model);
    if (resolved) return resolved;
  }

  if (legacyDataStore) {
    const effective = getEffectiveGeoreference(
      legacyDataStore,
      legacyCoordinateInfo,
      georefMutations.get('__legacy__'),
    );
    if (hasUsableMapGeoref(effective)) {
      return {
        modelId: '__legacy__',
        effective,
        storeyElevations: legacyDataStore.spatialHierarchy?.storeyElevations,
      };
    }
  }

  return null;
}

/**
 * Reactive anchor georef. Returns null when no loaded model carries a usable
 * map georef (callers should hide geo UI in that case).
 */
export function useAnchorGeoreference(): AnchorGeoreference | null {
  const models = useViewerStore((s) => s.models);
  const ifcDataStore = useViewerStore((s) => s.ifcDataStore);
  const legacyCoordinateInfo = useViewerStore((s) => s.geometryResult?.coordinateInfo);
  const anchorModelIdOverride = useViewerStore((s) => s.anchorModelIdOverride);
  const georefMutations = useViewerStore((s) => s.georefMutations);
  // Georef edits mutate in place; the version counter invalidates the memo.
  const mutationVersion = useViewerStore((s) => s.mutationVersion);

  return useMemo(
    () => resolveAnchorGeoreference({
      models,
      anchorModelIdOverride,
      georefMutations,
      legacyDataStore: ifcDataStore ?? undefined,
      legacyCoordinateInfo,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [models, anchorModelIdOverride, georefMutations, ifcDataStore, legacyCoordinateInfo, mutationVersion],
  );
}
