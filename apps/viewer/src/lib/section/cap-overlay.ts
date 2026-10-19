/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A cut, as the renderer's 3D cap overlay takes it. One conversion for every
 * plane's cap: the active plane's (from the Drawing) and the others' (#7545).
 */

import type { CutPolygon2D, DrawingLine2D } from '@ifc-lite/renderer';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { SectionPlane } from '@/store/types';
import { customPlaneCenter } from '@/store/slices/section-plane-center';

type Cut = Pick<Drawing2D, 'cutPolygons' | 'layerBaseCutPolygons' | 'lines'>;

export function capOverlayInput(cut: Cut, showHiddenLines: boolean, fillMode: 'uniform' | 'element' = 'uniform'): { polygons: CutPolygon2D[]; lines: DrawingLine2D[] } {
  // Opaque base cross-sections FIRST (one per multi-material entity, built from the
  // watertight union so they always close). The overlay triangulates polygons in
  // array order into one draw, so these render BEHIND the per-layer colours below;
  // where a layer's cap could not be reconstructed the base keeps the cut solid
  // instead of see-through. Colourless → uniform opaque cap fill.
  const basePolygons: CutPolygon2D[] = (cut.layerBaseCutPolygons ?? []).map((cp) => ({
    polygon: cp.polygon,
    ifcType: cp.ifcType,
    expressId: cp.entityId,
  }));
  const layerPolygons: CutPolygon2D[] = cut.cutPolygons.map((cp) => ({
    polygon: cp.polygon,
    ifcType: cp.ifcType,
    expressId: cp.entityId,
    // Per-layer material colour, so the cap matches the 3D build-up; undefined → uniform cap style.
    // "Element colour" fills every other polygon with its own source colour too.
    // Opaque: a translucent source (glass) would otherwise leave the cut see-through.
    color: cp.color ?? (fillMode === 'element' && cp.sourceColor ? [cp.sourceColor[0], cp.sourceColor[1], cp.sourceColor[2], 1] : undefined),
  }));
  const lines: DrawingLine2D[] = cut.lines
    .filter((line) => showHiddenLines || line.visibility !== 'hidden')
    .map((line) => ({ line: line.line, category: line.category }));
  return { polygons: [...basePolygons, ...layerPolygons], lines };
}

/**
 * For a face-picked plane (#243) the basis the cutter projected with, so the cap
 * lifts back onto the actual plane. The origin is the pick point projected onto
 * the LIVE plane (`customPlaneCenter`): dragging only changes `distance`, and an
 * origin off the plane makes the lift drop the normal component.
 */
export function capOverlayBasis(custom: SectionPlane['custom']) {
  return custom
    ? { origin: customPlaneCenter(custom), tangent: custom.tangent, bitangent: custom.bitangent }
    : undefined;
}
