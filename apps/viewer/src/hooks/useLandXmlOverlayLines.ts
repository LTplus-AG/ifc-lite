/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, type RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '../store/index.js';
import { collectLandXmlOverlaySpans, overlaySpanVertices } from './ingest/landXmlOverlaySpans.js';
import { runGpuUpload } from '@/components/viewer/gpu-upload-guard';

export interface LandXmlOverlayUploadTarget {
  setLineOverlay(channel: 'terrain', vertices: Float32Array | null): void;
}

/** Contain a terrain-line GPU upload and discard a partial buffer on failure. */
export function uploadLandXmlOverlayGuarded(
  renderer: LandXmlOverlayUploadTarget,
  vertices: Float32Array,
): void {
  if (vertices.length === 0) {
    renderer.setLineOverlay('terrain', null);
    return;
  }
  const uploaded = runGpuUpload('setLineOverlay:terrain', () => {
    renderer.setLineOverlay('terrain', vertices);
    return true;
  });
  if (!uploaded) renderer.setLineOverlay('terrain', null);
}

/**
 * LandXML 1.2 `Contour` permits a two-dimensional point list when its `elev`
 * attribute supplies the missing ordinate.  Boundaries and breaklines have no
 * equivalent schema field, so only contours may be lifted this way.
 */
/**
 * Adapt authored 3D LandXML boundary/breakline/contour coordinates into the
 * currently published model frame. A two-dimensional Contour with its
 * schema-defined `elev` attribute is lifted using that authored elevation;
 * other two-dimensional lists remain inspectable without invented geometry.
 */
export function useLandXmlOverlayLines(): Float32Array {
  const models = useViewerStore((state) => state.models);
  const selectedSource = useViewerStore((state) => state.selectedLandXmlSource);
  const placement = useViewerStore((state) => state.modelPlacement);
  return useMemo(() => overlaySpanVertices(collectLandXmlOverlaySpans({ models, selectedLandXmlSource: selectedSource, modelPlacement: placement })), [models, selectedSource, placement]);
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
    uploadLandXmlOverlayGuarded(renderer, vertices);
  }, [vertices, isInitialized, rendererRef]);
}
