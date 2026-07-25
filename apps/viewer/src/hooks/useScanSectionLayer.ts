/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scan section layer (issue #1805) — wires the pure band-selection math in
 * `scanSectionMath.ts` to the viewer store, so `Section2DPanel` can overlay
 * the loaded point cloud(s) on the 2D section/plan view.
 *
 * Point positions live in two different places depending on how the cloud
 * was ingested (see `scanSectionMath.ts`'s header for the coordinate story):
 *   - Streamed LAS/LAZ/PLY/PCD/E57 (`pointCloudIngest.ts`): GPU-only: read
 *     the bounded CPU reservoir sample `pointCloudScanCache.ts` retains,
 *     keyed by the model's `pointCloudHandleId`.
 *   - Inline IFCx point clouds: already fully in memory on
 *     `geometryResult.pointClouds[].chunk` — used directly.
 *
 * Recomputing the band selection is a synchronous O(retained points) pass
 * (see `selectScanBand`) — cheap per call (tens of ms at the multi-million
 * point retention cap) but debounced here so dragging the section slider
 * doesn't run it on every pointer-move tick.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeometryResult, PointCloudAsset } from '@ifc-lite/geometry';
import type { FederatedModel, SectionPlane } from '@/store/types';
import { customPlaneCenter } from '@/store';
import { getPointCloudScanSample } from './ingest/pointCloudScanCache.js';
import {
  selectScanBand,
  mergeScanBandSelections,
  DEFAULT_SCAN_RENDER_CAP,
  type ScanBandSelection,
  type ScanPointSample,
  type ScanSectionPlane,
} from './scanSectionMath.js';

/** Debounce window for recomputing the band selection on rapid slider drags. */
const RECOMPUTE_DEBOUNCE_MS = 120;

export const SCAN_SECTION_AXIS_MAP: Record<'down' | 'front' | 'side', 'x' | 'y' | 'z'> = {
  down: 'y',
  front: 'z',
  side: 'x',
};

export interface UseScanSectionLayerParams {
  enabled: boolean;
  sectionPlane: Pick<SectionPlane, 'axis' | 'position' | 'flipped' | 'custom'>;
  coordinateInfo: GeometryResult['coordinateInfo'] | undefined;
  /** Full slab thickness in metres. */
  thickness: number;
  /** 8-word LAS class-visibility mask; omit to show every class. */
  classMask?: readonly number[];
  models: ReadonlyMap<string, FederatedModel>;
  /** Legacy (no-federation) point clouds — `geometryResult.pointClouds`. */
  legacyPointClouds: readonly PointCloudAsset[] | undefined;
  maxRendered?: number;
}

export interface UseScanSectionLayerResult extends ScanBandSelection {
  /**
   * True when at least one point-cloud source is currently loaded/visible —
   * independent of `enabled`/`showScanSection`, so the panel can still say
   * "a scan is loaded, just hidden" instead of "no point cloud loaded".
   */
  hasPointCloud: boolean;
}

const EMPTY_SELECTION: ScanBandSelection = {
  points: [],
  totalInBand: 0,
  renderedCount: 0,
  stride: 1,
};

/** Gather every currently-loaded point cloud as a flat `ScanPointSample[]`. */
function collectScanSources(
  models: ReadonlyMap<string, FederatedModel>,
  legacyPointClouds: readonly PointCloudAsset[] | undefined,
): ScanPointSample[] {
  const sources: ScanPointSample[] = [];

  const pushInlineAsset = (asset: PointCloudAsset) => {
    if (asset.chunk.pointCount > 0 && asset.chunk.positions.length > 0) {
      sources.push({
        positions: asset.chunk.positions,
        colors: asset.chunk.colors,
        classifications: asset.chunk.classifications,
        count: asset.chunk.pointCount,
      });
    }
  };

  if (models.size > 0) {
    for (const model of models.values()) {
      if (!model.visible) continue;
      if (typeof model.pointCloudHandleId === 'number') {
        const cached = getPointCloudScanSample(model.pointCloudHandleId);
        if (cached && cached.count > 0) {
          sources.push({
            positions: cached.positions,
            colors: cached.colors ?? undefined,
            classifications: cached.classifications ?? undefined,
            count: cached.count,
          });
        }
      }
      for (const asset of model.geometryResult?.pointClouds ?? []) {
        pushInlineAsset(asset);
      }
    }
  } else {
    for (const asset of legacyPointClouds ?? []) {
      pushInlineAsset(asset);
    }
  }

  return sources;
}

function toScanSectionPlane(sectionPlane: UseScanSectionLayerParams['sectionPlane']): ScanSectionPlane {
  const axis = SCAN_SECTION_AXIS_MAP[sectionPlane.axis];
  if (!sectionPlane.custom) {
    return { axis, position: sectionPlane.position, flipped: sectionPlane.flipped };
  }
  const c = sectionPlane.custom;
  const origin = customPlaneCenter(c);
  return {
    axis,
    position: sectionPlane.position,
    flipped: sectionPlane.flipped,
    custom: {
      normal: c.normal,
      distance: c.distance,
      origin,
      tangent: c.tangent,
      bitangent: c.bitangent,
    },
  };
}

export function useScanSectionLayer(params: UseScanSectionLayerParams): UseScanSectionLayerResult {
  const {
    enabled, sectionPlane, coordinateInfo, thickness, classMask,
    models, legacyPointClouds, maxRendered = DEFAULT_SCAN_RENDER_CAP,
  } = params;

  const [selection, setSelection] = useState<ScanBandSelection>(EMPTY_SELECTION);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fold every dependency the computation reads into one key so the
  // debounce timer restarts exactly when something relevant changed —
  // including custom-plane drags (position stays constant; normal/distance
  // don't).
  const customKey = sectionPlane.custom
    ? `${sectionPlane.custom.normal.join(',')}|${sectionPlane.custom.distance}|${sectionPlane.custom.tangent.join(',')}|${sectionPlane.custom.bitangent.join(',')}`
    : '';
  const modelsKey = Array.from(models.entries())
    .map(([id, m]) => `${id}:${m.visible ? 1 : 0}:${m.pointCloudHandleId ?? ''}`)
    .join('|');

  // Cheap presence check (map lookups, no O(n) point scan) — independent of
  // `enabled` so the UI can report "a scan is loaded, just hidden".
  const hasPointCloud = useMemo(
    () => collectScanSources(models, legacyPointClouds).length > 0,
    // Keyed on `modelsKey` (a stable string), not `models` identity, since
    // the Map reference can change without any visible-content change.
    [modelsKey, legacyPointClouds],
  );

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!enabled) {
      setSelection(EMPTY_SELECTION);
      return;
    }

    timerRef.current = setTimeout(() => {
      const sources = collectScanSources(models, legacyPointClouds);
      if (sources.length === 0) {
        setSelection(EMPTY_SELECTION);
        return;
      }
      const plane = toScanSectionPlane(sectionPlane);
      const selections = sources.map((sample) => selectScanBand({
        sample, coordinateInfo, plane, thickness, classMask, maxRendered,
      }));
      setSelection(mergeScanBandSelections(selections));
    }, RECOMPUTE_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [
    enabled,
    sectionPlane.axis,
    sectionPlane.position,
    sectionPlane.flipped,
    customKey,
    coordinateInfo,
    thickness,
    classMask,
    modelsKey,
    legacyPointClouds,
    maxRendered,
  ]);

  return { ...selection, hasPointCloud };
}

export default useScanSectionLayer;
