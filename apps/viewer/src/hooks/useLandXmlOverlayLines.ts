/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, type RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { totalYupOffset } from '@ifc-lite/geometry/world-frame';
import { useViewerStore } from '../store/index.js';

/**
 * Adapt authored 3D LandXML boundary/breakline/contour coordinates into the
 * currently published model frame. Two-dimensional lists remain inspectable in
 * source records but are not lifted to an invented elevation.
 */
export function useLandXmlOverlayLines(): Float32Array {
  const models = useViewerStore((state) => state.models);
  const selectedSource = useViewerStore((state) => state.selectedLandXmlSource);
  return useMemo(() => {
    const vertices: number[] = [];
    for (const model of models.values()) {
      const document = model.landXmlDocument;
      const frame = model.geometryResult?.coordinateInfo;
      const units = document?.units;
      if (!document || !frame || !units) continue;
      const offset = totalYupOffset(frame);
      for (const surface of document.surfaces) {
        for (const line of [...surface.boundaries, ...surface.breaklines, ...surface.contours]) {
          // A source-list selection is deliberately a filter, not an IFC pick:
          // line GPU picking has no model/source identity channel. This keeps
          // the selected non-IFC record and its visible geometry in lockstep.
          if (selectedSource && (selectedSource.modelId !== model.id || selectedSource.sourceId !== line.sourceId)) {
            continue;
          }
          if (line.coordinateDimension !== 3) continue;
          for (let index = 1; index < line.points.length; index++) {
            const [northA, eastA, elevationA] = line.points[index - 1];
            const [northB, eastB, elevationB] = line.points[index];
            vertices.push(
              eastA * units.linearScaleToMeters - offset.x,
              elevationA * units.elevationScaleToMeters - offset.y,
              -northA * units.linearScaleToMeters - offset.z,
              eastB * units.linearScaleToMeters - offset.x,
              elevationB * units.elevationScaleToMeters - offset.y,
              -northB * units.linearScaleToMeters - offset.z,
            );
          }
        }
      }
    }
    return new Float32Array(vertices);
  }, [models, selectedSource]);
}

/** Keep the renderer's terrain channel synchronized with authored LandXML lines. */
export function useLandXmlRendererOverlay(
  rendererRef: RefObject<Renderer | null>,
  isInitialized: boolean,
): void {
  const vertices = useLandXmlOverlayLines();
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;
    renderer.setLineOverlay('terrain', vertices.length === 0 ? null : vertices);
  }, [vertices, isInitialized, rendererRef]);
}
