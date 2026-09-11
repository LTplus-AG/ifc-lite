/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store/types';
import { getEffectiveGeoreference, type GeorefMutationDataLike } from './effective-georef';
import { hasUsableMapGeoref, type MapGeoreference } from './pick-to-geo';

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

