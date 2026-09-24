/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, type RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { runGpuUpload } from '@/components/viewer/gpu-upload-guard';
import { anchorWorldLineVertices } from '@/lib/renderer/line-overlay-rte';
import { selectedCentrelineWorldLines } from '@/lib/analytic/selected-centreline-lines';
import { useSelectedSweptDisks } from './useSelectedSweptDisks';

/** Keep the optional selected-source overlay in its own renderer channel. */
export function useCentrelineRendererOverlay(
  rendererRef: RefObject<Renderer | null>, isInitialized: boolean,
): void {
  const enabled = useViewerStore((state) => state.centrelineOverlayEnabled);
  const models = useViewerStore((state) => state.models);
  const placement = useViewerStore((state) => state.modelPlacement);
  const georefMutations = useViewerStore((state) => state.georefMutations);
  const selected = useSelectedSweptDisks(enabled);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;
    let active = true;
    renderer.setLineOverlay('centreline', null);
    if (enabled && !selected.loading && selected.items.length > 0) {
      void selectedCentrelineWorldLines(selected.items, useViewerStore.getState()).then(({ vertices, diagnostics }) => {
        if (!active) return;
        if (diagnostics.length > 0) console.warn('[ifc-lite] Selected centreline overlay:', ...diagnostics);
        if (vertices.length === 0) return;
        const uploaded = runGpuUpload('setLineOverlay:centreline', () => {
          renderer.setLineOverlay('centreline', anchorWorldLineVertices(vertices));
          return true;
        });
        if (!uploaded) renderer.setLineOverlay('centreline', null);
      }).catch((error: unknown) => {
        if (active) console.error('[ifc-lite] Could not draw selected centreline', error);
      });
    } else if (selected.error) {
      console.warn('[ifc-lite] Selected centreline overlay:', selected.error);
    }
    return () => {
      active = false;
      renderer.setLineOverlay('centreline', null);
    };
  }, [enabled, selected, isInitialized, rendererRef, models, placement, georefMutations]);
}
