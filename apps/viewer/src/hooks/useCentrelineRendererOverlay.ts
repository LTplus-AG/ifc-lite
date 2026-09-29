/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { useTranslation } from '@/i18n';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { runGpuUpload } from '@/components/viewer/gpu-upload-guard';
import { anchorWorldLineVertices } from '@/lib/renderer/line-overlay-rte';
import { selectedCentrelineWorldLines } from '@/lib/analytic/selected-centreline-lines';
import { selectedCentrelineSnapCurves } from '@/lib/analytic/selected-centreline-snaps';
import { setSourceSegmentScreenProbe } from '@/lib/viewport-debug-hooks';
import { useSelectedSweptDisks } from './useSelectedSweptDisks';

/** Keep the optional selected-source overlay in its own renderer channel. */
export function useCentrelineRendererOverlay(
  rendererRef: RefObject<Renderer | null>, isInitialized: boolean,
  recoveryEpoch = 0,
  lineBuilder: typeof selectedCentrelineWorldLines = selectedCentrelineWorldLines,
): void {
  const enabled = useViewerStore((state) => state.centrelineOverlayEnabled);
  const models = useViewerStore((state) => state.models);
  const placement = useViewerStore((state) => state.modelPlacement);
  const georefMutations = useViewerStore((state) => state.georefMutations);
  const selectedIds = useViewerStore((state) => state.selectedEntityIds);
  const primaryId = useViewerStore((state) => state.selectedEntityId);
  const selectedRefs = useViewerStore((state) => state.selectedEntitiesSet);
  const primaryRef = useViewerStore((state) => state.selectedEntity);
  const hidden = useViewerStore((state) => state.hiddenEntities);
  const isolated = useViewerStore((state) => state.isolatedEntities);
  const classFilter = useViewerStore((state) => state.classFilter);
  const lensHidden = useViewerStore((state) => state.lensHiddenIds);
  const highlightedSegment = useViewerStore((state) => state.selectedDirectrixSegment);
  const selected = useSelectedSweptDisks(enabled);
  const { t } = useTranslation();
  const lastNotice = useRef<string | null>(null);
  const sourceEpoch = useRef(0);

  // Selection and visibility can change while the previous async source still
  // owns this channel. Clear it before paint and reject that source's late upload.
  useLayoutEffect(() => {
    sourceEpoch.current++;
    setSourceSegmentScreenProbe(null);
    if (isInitialized) {
      rendererRef.current?.setLineOverlay('centreline', null);
      rendererRef.current?.setSourceSnapCurves([]);
    }
  }, [enabled, isInitialized, recoveryEpoch, rendererRef, models, placement, georefMutations,
    selectedIds, primaryId, selectedRefs, primaryRef, hidden, isolated, classFilter, lensHidden,
    highlightedSegment]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;
    setSourceSegmentScreenProbe(null);
    let active = true;
    const epoch = sourceEpoch.current;
    renderer.setLineOverlay('centreline', null);
    renderer.setSourceSnapCurves([]);
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
      const state = useViewerStore.getState();
      void lineBuilder(selected.items, state, highlightedSegment).then(async ({ vertices, diagnostics, renderedOccurrences }) => {
        if (!active || epoch !== sourceEpoch.current) return;
        const snapDiagnostics: string[] = [];
        const curves = vertices.length > 0
          ? await selectedCentrelineSnapCurves(selected.items, state, highlightedSegment, renderedOccurrences,
            (message) => snapDiagnostics.push(message)) : [];
        if (!active || epoch !== sourceEpoch.current) return;
        report(selected.error ? [selected.error, ...diagnostics, ...snapDiagnostics] : [...diagnostics, ...snapDiagnostics]);
        if (vertices.length === 0) return;
        const uploaded = runGpuUpload('setLineOverlay:centreline', () => {
          renderer.setLineOverlay('centreline', anchorWorldLineVertices(vertices));
          return true;
        });
        if (uploaded) {
          renderer.setSourceSnapCurves(curves);
          setSourceSegmentScreenProbe((modelId, expressId, segmentIndex, t) => {
            const curve = curves.find((entry) => entry.identity.modelId === modelId
              && entry.identity.expressId === expressId && entry.identity.segmentIndex === segmentIndex);
            const point = curve?.pointAt(t);
            if (!point) return null;
            const rect = renderer.getCanvas().getBoundingClientRect();
            const screen = renderer.getCamera().projectToScreen(point, rect.width, rect.height);
            return screen ? { x: rect.left + screen.x, y: rect.top + screen.y, world: point } : null;
          });
        }
        else renderer.setLineOverlay('centreline', null);
      }).catch((error: unknown) => {
        if (active && epoch === sourceEpoch.current) report([`Could not draw selected centreline: ${String(error)}`]);
      });
    } else if (enabled && selected.error) {
      report([selected.error]);
    }
    return () => {
      active = false;
      renderer.setLineOverlay('centreline', null);
      renderer.setSourceSnapCurves([]);
      setSourceSegmentScreenProbe(null);
    };
  }, [enabled, selected, highlightedSegment, isInitialized, recoveryEpoch,
    rendererRef, models, placement, georefMutations, t, lineBuilder]);
}
