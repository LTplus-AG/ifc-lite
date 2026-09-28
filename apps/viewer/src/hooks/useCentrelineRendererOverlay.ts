/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { useTranslation } from '@/i18n';
import { toast } from '@/components/ui/toast';
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
  const { t } = useTranslation();
  const lastNotice = useRef<string | null>(null);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;
    let active = true;
    renderer.setLineOverlay('centreline', null);
    if (!enabled) lastNotice.current = null;
    const report = (messages: readonly string[]) => {
      if (messages.length === 0) return;
      const notice = `${selected.items.map((item) => `${item.ref.modelId}:${item.ref.expressId}`).join(',')}|${messages.length}|${messages[0]}`;
      if (lastNotice.current === notice) return;
      lastNotice.current = notice;
      for (const message of messages.slice(0, 10)) console.warn('[ifc-lite] Selected centreline overlay:', message);
      if (messages.length > 10) console.warn(`[ifc-lite] ${messages.length - 10} additional centreline diagnostics omitted from the console`);
      toast.error(t('ribbon.view.centrelineOmitted', { reason: messages[0]?.slice(0, 240) ?? '' }));
    };
    if (enabled && !selected.loading && selected.items.length > 0) {
      void selectedCentrelineWorldLines(selected.items, useViewerStore.getState()).then(({ vertices, diagnostics }) => {
        if (!active) return;
        report(selected.error ? [selected.error, ...diagnostics] : diagnostics);
        if (vertices.length === 0) return;
        const uploaded = runGpuUpload('setLineOverlay:centreline', () => {
          renderer.setLineOverlay('centreline', anchorWorldLineVertices(vertices));
          return true;
        });
        if (!uploaded) renderer.setLineOverlay('centreline', null);
      }).catch((error: unknown) => {
        if (active) report([`Could not draw selected centreline: ${String(error)}`]);
      });
    } else if (selected.error) {
      report([selected.error]);
    }
    return () => {
      active = false;
      renderer.setLineOverlay('centreline', null);
    };
  }, [enabled, selected, isInitialized, rendererRef, models, placement, georefMutations, t]);
}
