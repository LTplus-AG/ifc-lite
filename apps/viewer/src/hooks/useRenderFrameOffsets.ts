/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The offsets the geometry pipeline applied to get the loaded model(s) into
 * the render frame, for turning a picked renderer-space point back into the
 * model's own world coordinates (#2199 §5).
 *
 * Unlike the Properties panel — which resolves these per SELECTED ENTITY, and
 * so per model — a picked point has no model of its own. It lands wherever the
 * cursor hit the shared scene. The scene has exactly one frame, so this
 * resolves the frame ONCE, from the earliest-loaded model.
 *
 * That is not an approximation: a federation is aligned to the first model's
 * RTC frame at load (see `geometry-parallel`'s alignment pass), so the first
 * model's offsets ARE the scene's offsets. Reading a later model's offsets
 * instead would report a point's world coordinates against a frame the scene
 * is not actually drawn in.
 */

import { useMemo } from 'react';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import type { RenderFrameOffsets } from '@/components/viewer/tools/measure-modes/coordinates';

export function useRenderFrameOffsets(): RenderFrameOffsets {
  const models = useViewerStore((s) => s.models);
  const geometryResult = useViewerStore((s) => s.geometryResult);

  return useMemo(() => {
    // Federated: the earliest-loaded model owns the frame every other model
    // was aligned to.
    let earliest = Infinity;
    let info: CoordinateInfo | null = null;
    for (const [, m] of models) {
      if (m.loadedAt < earliest && m.geometryResult?.coordinateInfo) {
        earliest = m.loadedAt;
        info = m.geometryResult.coordinateInfo;
      }
    }
    // Legacy single-model load: no federated entry, one geometry result.
    if (!info) info = geometryResult?.coordinateInfo ?? null;

    return {
      originShift: info?.originShift ?? null,
      wasmRtcOffsetIfc: info?.wasmRtcOffset ?? null,
    };
  }, [models, geometryResult]);
}
