/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { Renderer, SourceSnapCurve } from '@ifc-lite/renderer';
import { useTranslation } from '@/i18n';
import { toast } from '@/components/ui/toast';
import { entityRefToString, useViewerStore } from '@/store';
import { runGpuUpload } from '@/components/viewer/gpu-upload-guard';
import { anchorWorldLineVertices } from '@/lib/renderer/line-overlay-rte';
import { selectedCentrelineWorldLines } from '@/lib/analytic/selected-centreline-lines';
import { selectedCentrelineSnapCurves } from '@/lib/analytic/selected-centreline-snaps';
import { setSourceSegmentScreenProbe } from '@/lib/viewport-debug-hooks';
import { selectedSweptDiskProducts, useSelectedSweptDisks } from './useSelectedSweptDisks';

/**
 * The selection order moves the primary product first, so the same curves can
 * come back reordered. The pick revision compares the set in order, and an
 * exact screen-distance tie goes to the first curve; one order per set keeps
 * both unchanged (#9086).
 */
function bySourceIdentity(a: SourceSnapCurve, b: SourceSnapCurve): number {
  const x = a.identity, y = b.identity;
  return x.modelId < y.modelId ? -1 : x.modelId > y.modelId ? 1
    : x.expressId - y.expressId || x.occurrenceIndex - y.occurrenceIndex || x.segmentIndex - y.segmentIndex;
}

/** The curves of the products the swept-disk query loads now; a product it dropped cannot be snapped to (#5778). */
function stillQueried(curves: readonly SourceSnapCurve[]): SourceSnapCurve[] {
  if (curves.length === 0) return [];
  const { grouped } = selectedSweptDiskProducts(useViewerStore.getState());
  const loaded = new Set([...grouped].flatMap(([modelId, ids]) => ids.map((expressId) => entityRefToString({ modelId, expressId }))));
  return curves.filter(({ identity }) => loaded.has(entityRefToString(identity)));
}

const sameValues = (a: readonly unknown[], b: readonly unknown[]) => a.every((value, index) => Object.is(value, b[index]));

/** Keep the optional selected-source overlay in its own renderer channel. */
export function useCentrelineRendererOverlay(
  rendererRef: RefObject<Renderer | null>, isInitialized: boolean,
  recoveryEpoch = 0,
  lineBuilder: typeof selectedCentrelineWorldLines = selectedCentrelineWorldLines,
): void {
  const enabled = useViewerStore((state) => state.centrelineOverlayEnabled);
  const models = useViewerStore((state) => state.models);
  // In a federation `ifcDataStore` only mirrors the active model; it is the curves' source only without one.
  const legacyStore = useViewerStore((state) => state.models.size === 0 ? state.ifcDataStore : null);
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
  /** The curves this overlay last gave the magnetic pick. */
  const installedCurves = useRef<readonly SourceSnapCurve[]>([]);
  /** The inputs that place the curves, as the last layout pass saw them (#9086). */
  const lastFrame = useRef<readonly unknown[] | null>(null);
  const installCurves = (renderer: Renderer | null | undefined, curves: readonly SourceSnapCurve[]) => {
    const next = [...curves].sort(bySourceIdentity);
    const held = installedCurves.current;
    // The renderer keys a set by its content; skip that when it already holds these very curves.
    if (next.length > 0 && next.length === held.length && sameValues(next, held)) return;
    installedCurves.current = next;
    renderer?.setSourceSnapCurves(next);
  };

  // Selection and visibility can change while the previous async source still
  // owns this channel. Clear it before paint and reject that source's late upload.
  // A selection or visibility change keeps the curves of the products the
  // query still loads, so an unchanged set never empties between frames and
  // a resting Measure Point reading stays Live (#9086); a dropped product's
  // curves still leave before paint (#5778). Anything that can move or
  // re-evaluate the curves clears them all.
  useLayoutEffect(() => {
    sourceEpoch.current++;
    setSourceSegmentScreenProbe(null);
    const frame = [enabled, isInitialized, recoveryEpoch, rendererRef.current, models, legacyStore, placement,
      georefMutations, highlightedSegment];
    const sameFrame = lastFrame.current !== null && sameValues(lastFrame.current, frame);
    lastFrame.current = frame;
    if (!isInitialized) return;
    rendererRef.current?.setLineOverlay('centreline', null);
    installCurves(rendererRef.current, sameFrame ? stillQueried(installedCurves.current) : []);
  }, [enabled, isInitialized, recoveryEpoch, rendererRef, models, legacyStore, placement, georefMutations,
    selectedIds, primaryId, selectedRefs, primaryRef, hidden, isolated, classFilter, lensHidden,
    highlightedSegment]);

  // Unmounting drops the curves the overlay installed.
  useEffect(() => () => installCurves(rendererRef.current, []), [rendererRef]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;
    setSourceSegmentScreenProbe(null);
    let active = true;
    const epoch = sourceEpoch.current;
    renderer.setLineOverlay('centreline', null);
    // This effect also re-runs for a highlight or model change while
    // `selected` still answers an older query; a newer `selected` is on its
    // way, so building the old records would install curves the selection
    // dropped or a model replaced.
    const current = () => selected.current?.() ?? true;
    // A pending rebuild keeps the curves the selection still shows (#9086).
    if (!enabled || (current() && !selected.loading && selected.items.length === 0)) installCurves(renderer, []);
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
    if (enabled && current() && !selected.loading && selected.items.length > 0) {
      const state = useViewerStore.getState();
      void lineBuilder(selected.items, state, highlightedSegment).then(async ({ vertices, diagnostics, renderedOccurrences }) => {
        if (!active || epoch !== sourceEpoch.current || !current()) return;
        const snapDiagnostics: string[] = [];
        const curves = vertices.length > 0
          ? await selectedCentrelineSnapCurves(selected.items, state, highlightedSegment, renderedOccurrences,
            (message) => snapDiagnostics.push(message)) : [];
        if (!active || epoch !== sourceEpoch.current || !current()) return;
        report(selected.error ? [selected.error, ...diagnostics, ...snapDiagnostics] : [...diagnostics, ...snapDiagnostics]);
        if (vertices.length === 0) { installCurves(renderer, []); return; }
        const uploaded = runGpuUpload('setLineOverlay:centreline', () => {
          renderer.setLineOverlay('centreline', anchorWorldLineVertices(vertices));
          return true;
        });
        installCurves(renderer, uploaded ? stillQueried(curves) : []);
        if (uploaded) {
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
        if (!active || epoch !== sourceEpoch.current || !current()) return;
        installCurves(renderer, []);
        report([`Could not draw selected centreline: ${String(error)}`]);
      });
    } else if (enabled && current() && selected.error) {
      report([selected.error]);
    }
    return () => {
      active = false;
      renderer.setLineOverlay('centreline', null);
      setSourceSegmentScreenProbe(null);
    };
  }, [enabled, selected, highlightedSegment, isInitialized, recoveryEpoch,
    rendererRef, models, placement, georefMutations, t, lineBuilder]);
}
