/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The caps of the cutting planes that are not the active one (#7545).
 *
 * The active plane's cap comes out of the Drawing panel's own drawing
 * (`useDrawingGeneration`: projection, hidden lines, symbols). Every other
 * enabled plane needs only its section polygons and cut lines, so each is cut
 * here with the plain cutter, from the same visible meshes, and parked in the
 * store (`sectionExtraCaps`) for `useRenderUpdates` to hand to the renderer.
 *
 * Cuts run one at a time through the drawing request queue; a newer input
 * supersedes older ones. A plane is re-cut only when its signature (its geometry
 * and the model state it was cut from) changes, so dragging the active plane
 * never re-cuts the others.
 */

import { useEffect, useRef } from 'react';
import { Drawing2DGenerator } from '@ifc-lite/drawing-2d';
import type { GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { capCutConfig, capSignature } from '@/lib/section/section-cut-config';
import { visibleCutMeshes } from '@/lib/drawing/cut-meshes';
import { createDrawingRequestQueue } from './drawingRequestQueue.js';

export function useExtraSectionCaps(
  geometryResult: GeometryResult | null | undefined,
  computedIsolatedIds: ReadonlySet<number> | null | undefined,
): void {
  const planes = useViewerStore((s) => s.inactiveSectionPlanes);
  const caps = useViewerStore((s) => s.sectionExtraCaps);
  const activeTool = useViewerStore((s) => s.activeTool);
  const show3DOverlay = useViewerStore((s) => s.drawing2DDisplayOptions.show3DOverlay);
  const typeVisibility = useViewerStore((s) => s.typeVisibility);
  const hiddenIds = useViewerStore((s) => s.hiddenEntities);
  const isolatedIds = useViewerStore((s) => s.isolatedEntities);
  const setCap = useViewerStore((s) => s.setSectionExtraCap);
  const prune = useViewerStore((s) => s.pruneSectionExtraCaps);

  const queueRef = useRef<ReturnType<typeof createDrawingRequestQueue> | null>(null);
  if (!queueRef.current) queueRef.current = createDrawingRequestQueue();
  // Bumped whenever what the cuts are made FROM changes, so every parked cap goes stale at once.
  const modelStateRef = useRef({ token: 0, inputs: [] as unknown[] });
  const inputs = [geometryResult, hiddenIds, isolatedIds, computedIsolatedIds, typeVisibility];
  if (inputs.some((v, i) => v !== modelStateRef.current.inputs[i])) {
    modelStateRef.current = { token: modelStateRef.current.token + 1, inputs };
  }
  const modelToken = modelStateRef.current.token;

  const wanted = activeTool === 'section' && show3DOverlay && !!geometryResult
    ? planes.filter((p) => p.enabled)
    : [];
  // Re-run when the set of wanted planes or their geometry changes, not on every store tick.
  const wantedKey = wanted.map((p) => `${p.id}:${capSignature(p)}`).join('|');

  useEffect(() => {
    const queue = queueRef.current!;
    prune(wanted.map((p) => p.id));
    const cancel = () => queue.cancel();
    if (wanted.length === 0 || !geometryResult) return cancel;

    const stale = wanted.filter((p) => caps[p.id]?.signature !== `${modelToken}:${capSignature(p)}`);
    if (stale.length === 0) return cancel;

    void queue.request(async (isCurrent) => {
      const generator = new Drawing2DGenerator();
      await generator.initialize();
      if (!isCurrent()) return;
      const meshes = visibleCutMeshes(geometryResult.meshes, {
        typeVisibility, hiddenIds, isolatedIds, computedIsolatedIds,
      });
      const bounds = geometryResult.coordinateInfo.shiftedBounds;
      for (const plane of stale) {
        const signature = `${modelToken}:${capSignature(plane)}`;
        const config = capCutConfig(plane, bounds);
        if (!config || meshes.length === 0) {
          if (isCurrent()) setCap(plane.id, { signature, cutPolygons: [], lines: [] });
          continue;
        }
        const result = await generator.generate(meshes, config, {
          includeHiddenLines: false,
          includeProjection: false,
          includeEdges: false,
          mergeLines: true,
        });
        if (!isCurrent()) return;
        setCap(plane.id, {
          signature,
          cutPolygons: result.cutPolygons,
          layerBaseCutPolygons: result.layerBaseCutPolygons,
          lines: result.lines,
        });
      }
    }).catch((error) => console.error('Cutting plane cap failed:', error));
    return cancel;
    // `caps` is read for staleness only; its own writes must not retrigger the cut.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, modelToken, geometryResult]);
}
