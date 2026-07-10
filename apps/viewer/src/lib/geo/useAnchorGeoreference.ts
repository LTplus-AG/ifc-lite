/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resolve the federation *anchor* model's effective georeference — the model
 * whose projected CRS + IfcMapConversion define the world frame every other
 * model's vertices were baked into.
 *
 * The selection order (user-pinned anchor, else earliest-loaded model with a
 * usable map-conversion georef, else the legacy single-model store fields)
 * matches `findReferenceGeorefModel` in useIfcFederation, the Cesium georef
 * memo in ViewportContainer, and the basepoint overlay's anchor input, so the
 * measure-tool XYZ readout places points in exactly the frame the geometry was
 * placed in.
 *
 * Unlike the Cesium/solar georef memo, this hook is NOT gated on
 * `cesiumEnabled` / `solarEnabled`: the measure readout must work with Cesium
 * and the solar study both off. It also exposes the anchor's IFC-origin viewer
 * position synchronously (`-totalYupOffset`, valid because the anchor is always
 * its own frame), so callers never await a proj4 hop.
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
import { totalYupOffset } from './ifc-origin';
import { hasUsableMapGeoref, type MapGeoreference, type Vec3 } from './pick-to-geo';

/** The store field set when a single model loads without going through federation. */
const LEGACY_MODEL_ID = '__legacy__';

export interface AnchorGeorefSelection {
  /** Model id, or `'__legacy__'` for the single-model fallback store fields. */
  modelId: string;
  /** Effective georef, guaranteed to carry a usable map conversion + CRS name. */
  eff: MapGeoreference;
  /** The anchor model's coordinate info (drives the IFC-origin viewer position). */
  coordinateInfo?: CoordinateInfo;
}

export interface SelectAnchorGeorefParams {
  models: Map<string, FederatedModel>;
  legacyDataStore?: IfcDataStore | null;
  legacyCoordinateInfo?: CoordinateInfo;
  anchorModelIdOverride?: string | null;
  georefMutations: Map<string, GeorefMutationDataLike>;
}

/**
 * Pure anchor-selection shared by the measure readout, the basepoint overlay,
 * and (for its selection step) the Cesium georef memo.
 */
export function selectAnchorGeoref({
  models,
  legacyDataStore,
  legacyCoordinateInfo,
  anchorModelIdOverride,
  georefMutations,
}: SelectAnchorGeorefParams): AnchorGeorefSelection | null {
  const build = (
    modelId: string,
    dataStore: IfcDataStore,
    coordinateInfo: CoordinateInfo | undefined,
  ): AnchorGeorefSelection | null => {
    const eff = getEffectiveGeoreference(dataStore, coordinateInfo, georefMutations.get(modelId));
    if (!hasUsableMapGeoref(eff)) return null;
    return { modelId, eff, coordinateInfo };
  };

  if (models.size > 0) {
    if (anchorModelIdOverride) {
      const pinned = models.get(anchorModelIdOverride);
      if (pinned?.ifcDataStore) {
        const got = build(
          anchorModelIdOverride,
          pinned.ifcDataStore as IfcDataStore,
          pinned.geometryResult?.coordinateInfo,
        );
        if (got) return got;
      }
    }
    // Earliest-loaded model with a usable georef wins (stable across reloads).
    const ordered = Array.from(models.values()).sort(
      (a, b) => (a.loadedAt ?? 0) - (b.loadedAt ?? 0),
    );
    for (const model of ordered) {
      if (!model.ifcDataStore) continue;
      const got = build(
        model.id,
        model.ifcDataStore as IfcDataStore,
        model.geometryResult?.coordinateInfo,
      );
      if (got) return got;
    }
  }

  if (legacyDataStore) {
    const got = build(LEGACY_MODEL_ID, legacyDataStore, legacyCoordinateInfo);
    if (got) return got;
  }

  return null;
}

export interface AnchorGeoreference extends AnchorGeorefSelection {
  /** Viewer-space (Y-up) position of the anchor model's IFC (0,0,0). */
  originViewer: Vec3;
}

/**
 * React hook wrapping {@link selectAnchorGeoref} with the store subscriptions
 * the measure readout needs. Recomputes only when the georef inputs change
 * (model load/removal, anchor override, or a georef field edit via
 * `mutationVersion`), never per camera frame or per measurement.
 */
export function useAnchorGeoreference(): AnchorGeoreference | null {
  const models = useViewerStore((s) => s.models);
  const ifcDataStore = useViewerStore((s) => s.ifcDataStore);
  const geometryResult = useViewerStore((s) => s.geometryResult);
  const anchorModelIdOverride = useViewerStore((s) => s.anchorModelIdOverride);
  const georefMutations = useViewerStore((s) => s.georefMutations);
  // Re-derive when any georef edit lands (mutations map is replaced, but this
  // makes the dependency explicit and matches BasepointOverlay).
  const mutationVersion = useViewerStore((s) => s.mutationVersion);

  return useMemo(() => {
    const selection = selectAnchorGeoref({
      models,
      legacyDataStore: ifcDataStore as IfcDataStore | null,
      legacyCoordinateInfo: geometryResult?.coordinateInfo,
      anchorModelIdOverride,
      georefMutations,
    });
    if (!selection) return null;
    const off = totalYupOffset(selection.coordinateInfo);
    return {
      ...selection,
      originViewer: { x: -off.x, y: -off.y, z: -off.z },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, ifcDataStore, geometryResult, anchorModelIdOverride, georefMutations, mutationVersion]);
}
