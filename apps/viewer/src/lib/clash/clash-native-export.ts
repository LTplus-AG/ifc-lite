/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { captureEntityViewportFrame } from '@/lib/export/entity-viewport-capture';
import { useViewerStore } from '@/store';
import { groupClashes, clashReviewKey, type Clash, type ClashGroup, type ClashReviewStatus } from '@ifc-lite/clash';
import { createBCFFromClashResult } from '@ifc-lite/clash/bcf';
import { writeBCF } from '@ifc-lite/bcf';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { bcfWorldOffset } from '@/hooks/bcf/viewpoint-world-frame';
import { filterResultBySeverity } from '@/lib/clash/severity-filter';
import type { ClashBcfConfig } from '@/lib/clash/bcf-export-config';
import { trackExportCompleted } from '@/lib/analytics';
import { bcfExportFilename, downloadBlob, dataUrlToBytes } from '@/lib/export/download';
import { analysisStampFrom, isAnalysisStale } from '@/hooks/useAnalysisStaleness';
const SNAPSHOT_CLEAR_COLOR: [number, number, number, number] = [0.04, 0.05, 0.1, 1];
export function createClashExport(
  options: { signal?: AbortSignal; emit?: (blob: Blob, filename: string) => void | Promise<void> } = {},
) {
  const bcfPreview = (
    config: ClashBcfConfig,
  ): {
    clashes: number;
    topics: number;
  } => {
    options.signal?.throwIfAborted();
    const state = useViewerStore.getState();
    const current = state.clashResult;
    if (!current) return { clashes: 0, topics: 0 };
    const filtered = filterResultBySeverity(current, new Set(config.severities), config.clashIds);
    if (filtered.clashes.length === 0) return { clashes: 0, topics: 0 };
    const groups = groupClashes(filtered, { by: config.groupBy, epsilon: state.clashClusterEpsilon });
    const capped = Math.min(groups.length, config.maxTopics);
    const overflow = groups.length > config.maxTopics ? 1 : 0;
    return { clashes: filtered.clashes.length, topics: capped + overflow };
  };
  const exportBcf = async (
    config: ClashBcfConfig,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> => {
    const state = useViewerStore.getState();
    const current = state.clashResult;
    if (!current) return;
    const filtered = filterResultBySeverity(current, new Set(config.severities), config.clashIds);
    if (filtered.clashes.length === 0) return;
    const groups = groupClashes(filtered, { by: config.groupBy, epsilon: state.clashClusterEpsilon });
    let snapshotProvider: ((group: ClashGroup) => Promise<Uint8Array | undefined>) | undefined;
    if (config.includeSnapshots) {
      const renderer = getGlobalRenderer();
      if (renderer) {
        const total = Math.min(groups.length, config.maxTopics);
        let done = 0;
        // Group members name renderer ids of the models loaded at start; another set of models makes one-sided PNGs.
        const stamp = analysisStampFrom(state, true);
        // Checked after each capture: the gate refuses once cancelled, and a model can change while a frame renders.
        const assertScene = () => {
          options.signal?.throwIfAborted();
          if (isAnalysisStale(stamp, useViewerStore.getState()))
            throw new Error('The models were edited, moved or unloaded during the clash BCF export. Export again.');
        };
        snapshotProvider = async (group: ClashGroup): Promise<Uint8Array | undefined> => {
          const b = group.bounds;
          const isolation = new Set<number>();
          for (const m of group.members) {
            isolation.add(m.a.ref);
            isolation.add(m.b.ref);
          }
          const dataUrl = await captureEntityViewportFrame(renderer, {
            ids: isolation,
            mode: 'isolate',
            bounds: { min: { x: b.min[0], y: b.min[1], z: b.min[2] }, max: { x: b.max[0], y: b.max[1], z: b.max[2] } },
            clearColor: SNAPSHOT_CLEAR_COLOR,
            signal: options.signal,
          });
          assertScene();
          done += 1;
          onProgress?.(done, total);
          return dataUrl ? dataUrlToBytes(dataUrl) : undefined;
        };
      }
    }
    const reviewsMap = state.clashReviews;
    const reviewStatusOf = (clash: Clash): ClashReviewStatus => reviewsMap.get(clashReviewKey(clash))?.status ?? 'open';
    try {
      const project = await createBCFFromClashResult(filtered, groups, {
        author: 'clash@ifc-lite',
        projectName: 'Clash report',
        reviewStatusOf,
        modelNameOf: (id) => state.models.get(id)?.name ?? id,
        worldOffset: bcfWorldOffset(state.models, state.geometryResult),
        maxTopics: config.maxTopics,
        ...(snapshotProvider ? { snapshotProvider } : {}),
      });
      const blob = await writeBCF(project);
      options.signal?.throwIfAborted();
      await (options.emit ?? downloadBlob)(blob, bcfExportFilename('clashes'));
      trackExportCompleted({ format: 'bcfzip', surface: 'clash_results' });
    } finally {
      getGlobalRenderer()?.requestRender();
    }
  };
  return { bcfPreview, exportBcf };
}
