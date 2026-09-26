/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `BasepointOverlay` — a `Pin` + `WorldLabel` at the viewer-space position
 * of each loaded model's IFC (0,0,0) point, on the shared scene-overlay
 * kernel (#5486/#5512, charter #5478).
 *
 * Helps users diagnose federation alignment problems by showing where each
 * model THINKS its origin is in the displayed scene. For a correctly
 * federated set with shared CRS, the origins land at distinct points spaced
 * by their (eastings, northings, orthogonalHeight) differences. When the
 * pipeline collapses everything onto one point, you'll see all the markers
 * stacked.
 *
 * Origins are derived from each model's neutral spatial reference — independent
 * of vertex-baked alignment, so they stay correct after re-aligns and across
 * cross-CRS reprojections without maintaining a second IFC conversion seam.
 *
 * Before the kernel this ran its own `requestAnimationFrame` +
 * `Camera.projectToScreen` poll (unconditional, every frame, forever) and
 * built the marker SVG by hand via `svg.innerHTML`. `Pin`'s `fill` override
 * carries the per-model status colour (data, not a theme token — roadmap
 * §3), same pattern `PeerPresenceLayer` uses for a collab peer's colour.
 */

import { useEffect, useMemo, useState } from 'react';
import { useViewerStore } from '@/store';
import { Pin, WorldLabel } from '@/components/viewport-ui/scene';
import {
  computeIfcOriginViewerPosition,
  type IfcOriginPlacement,
  type IfcOriginFrame,
} from '@/lib/geo/ifc-origin';
import { extractModelSpatialPlacement, findReferenceSpatialModel } from '@/hooks/ingest/federationAlign';
import type { FederatedModel } from '@/store/types';
import type { IfcDataStore } from '@ifc-lite/parser';

interface BasepointDot {
  modelId: string;
  modelName: string;
  status: FederatedModel['federationAlignmentStatus'];
  /** Viewer-space (Y-up) position of the model's IFC (0,0,0) point. */
  viewer: { x: number; y: number; z: number };
}

const STATUS_COLOUR: Record<NonNullable<FederatedModel['federationAlignmentStatus']> | 'none', string> = {
  anchor: '#f59e0b', // amber
  'same-crs': '#10b981', // emerald
  reprojected: '#10b981', // emerald
  identity: '#10b981', // emerald
  failed: '#ef4444', // red
  none: '#a1a1aa', // zinc
};

export function BasepointOverlay() {
  const showModelBasepoints = useViewerStore((s) => s.showModelBasepoints);
  const models = useViewerStore((s) => s.models);
  const anchorModelIdOverride = useViewerStore((s) => s.anchorModelIdOverride);
  const georefMutations = useViewerStore((s) => s.georefMutations);
  // Re-derive origins when any georef edit lands.
  useViewerStore((s) => s.mutationVersion);

  const [dots, setDots] = useState<BasepointDot[]>([]);

  // The overlay must use the exact same canonical-anchor predicate as the
  // federation. A display label is not a CRS identity and must not become one
  // merely because a diagnostic overlay happened to read it.
  const anchorInput = useMemo((): { id: string | null; input: IfcOriginFrame | null } => {
    const selection = findReferenceSpatialModel();
    return selection ? { id: selection.modelId, input: selection.placement } : { id: null, input: null };
  }, [models, anchorModelIdOverride, georefMutations]);

  // Recompute every model's IFC-origin viewer position when the inputs change.
  useEffect(() => {
    if (!showModelBasepoints) {
      setDots([]);
      return;
    }

    let cancelled = false;

    (async () => {
      const results: BasepointDot[] = [];
      for (const [modelId, model] of models) {
        if (!model.visible) continue;
        const ds = model.ifcDataStore;
        if (!ds) continue;
        const ownPlacement = extractModelSpatialPlacement(
          ds as IfcDataStore,
          model.geometryResult?.coordinateInfo,
          georefMutations.get(modelId),
        );
        const modelInput: IfcOriginFrame = {
          ...(ownPlacement ?? {}),
          coordinateInfo: model.geometryResult?.coordinateInfo,
          preAlignmentCoordinateInfo: model.preAlignment?.coordinateInfo,
        };
        const anchorIsThis = anchorInput.id === modelId;
        const placement: IfcOriginPlacement | null = await computeIfcOriginViewerPosition(
          modelInput,
          anchorIsThis ? null : anchorInput.input,
        );
        if (!placement) continue;
        results.push({
          modelId,
          modelName: model.name,
          status: anchorIsThis ? 'anchor' : (model.federationAlignmentStatus ?? 'none'),
          viewer: placement.viewer,
        });
      }
      if (cancelled) return;
      setDots(results);
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showModelBasepoints, models, anchorInput, georefMutations]);

  if (!showModelBasepoints) return null;

  return (
    <>
      {dots.map((dot) => {
        const colour = STATUS_COLOUR[dot.status ?? 'none'];
        return (
          <BasepointMarker key={dot.modelId} dot={dot} colour={colour} />
        );
      })}
    </>
  );
}

/** One model's origin marker + name label, kept as its own component so
 *  each dot owns a stable set of hook calls independent of how many other
 *  models are loaded. */
function BasepointMarker({ dot, colour }: { dot: BasepointDot; colour: string }) {
  return (
    <>
      <Pin worldPoint={dot.viewer} fill={colour} title={dot.modelName} />
      <WorldLabel worldPoint={dot.viewer} offset={{ dx: 14, dy: -28 }}>
        <span className="font-mono" style={{ color: colour }}>
          {dot.modelName}
        </span>
      </WorldLabel>
    </>
  );
}
