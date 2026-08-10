/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The offsets the geometry pipeline applied to get the loaded model(s) into
 * the render frame, for turning a picked renderer-space point back into world
 * coordinates (#2199 §5).
 *
 * Unlike the Properties panel — which resolves these per SELECTED ENTITY, and
 * so per model — a picked point has no model of its own. It lands wherever the
 * cursor hit the shared scene. The scene has exactly one frame, so this
 * resolves the frame ONCE, from the earliest-loaded model: a federation is
 * aligned to the first model's RTC frame at load (see `geometry-parallel`'s
 * alignment pass), so the first model's offsets ARE the scene's offsets.
 * Reading a later model's offsets instead would report a point's coordinates
 * against a frame the scene is not actually drawn in.
 *
 * That makes the NUMBERS right in every case, and the LABEL right in all but
 * one. When alignment actually re-based another model into this frame
 * (`'same-crs'` / `'reprojected'`), a point picked on that model comes back in
 * the ANCHOR file's coordinate system, not in its own file's — the two differ
 * by exactly the transform alignment applied. Since a picked point carries no
 * model, there is nothing to invert against; what there is instead is the
 * truth, so {@link RenderFrameProvenance.rebased} is reported and the readout
 * labels the row for the frame it is genuinely in. Same rule as the rest of
 * #2199: state the basis, do not pick one silently.
 */

import { useMemo } from 'react';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { geometryVolumesSurviveAlignment } from '@/lib/compare/alignmentTrust';
import type { RenderFrameOffsets } from '@/components/viewer/tools/measure-modes/coordinates';

/** Whose coordinate system a reconstructed world point is actually in. */
export interface RenderFrameProvenance {
  /**
   * True when at least one OTHER loaded model was re-based into this frame by
   * federation alignment, so "world" means the anchor file's coordinate
   * system rather than necessarily the picked model's own.
   */
  rebased: boolean;
  /** Name of the model that owns the frame, when it can be named. */
  anchorName: string | null;
}

export type RenderFrameResult = RenderFrameOffsets & RenderFrameProvenance;

export function useRenderFrameOffsets(): RenderFrameResult {
  const models = useViewerStore((s) => s.models);
  const geometryResult = useViewerStore((s) => s.geometryResult);

  return useMemo(() => {
    // Federated: the earliest-loaded model owns the frame every other model
    // was aligned to.
    let earliest = Infinity;
    let info: CoordinateInfo | null = null;
    let anchorName: string | null = null;
    let rebased = false;
    for (const [, m] of models) {
      if (m.loadedAt < earliest && m.geometryResult?.coordinateInfo) {
        earliest = m.loadedAt;
        info = m.geometryResult.coordinateInfo;
        anchorName = m.name ?? null;
      }
      // `geometryVolumesSurviveAlignment` is the same two-status question
      // asked of the same alignment pass (#1993): those are exactly the
      // statuses under which vertices were re-baked into the anchor frame.
      if (!geometryVolumesSurviveAlignment(m.federationAlignmentStatus)) rebased = true;
    }
    // Legacy single-model load: no federated entry, one geometry result.
    if (!info) info = geometryResult?.coordinateInfo ?? null;

    return {
      originShift: info?.originShift ?? null,
      wasmRtcOffsetIfc: info?.wasmRtcOffset ?? null,
      rebased,
      anchorName,
    };
  }, [models, geometryResult]);
}
