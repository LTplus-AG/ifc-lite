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
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { totalYupOffset } from './ifc-origin';
import type { Vec3 } from './pick-to-geo';
import { selectAnchorGeoref, type AnchorGeorefSelection } from './select-anchor-georef';
export { selectAnchorGeoref, type AnchorGeorefSelection, type SelectAnchorGeorefParams } from './select-anchor-georef';

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
