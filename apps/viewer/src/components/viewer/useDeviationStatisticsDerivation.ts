/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type RefObject } from 'react';
import type { DeviationDistances } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { stampAnalysisReport, type AnalysisStamp } from '@/hooks/useAnalysisStaleness';
import {
  countDeviationWithinTolerance, summarizeDeviationRun, type PointCloudDeviationStatistics,
} from '@/lib/point-cloud/deviation-run-statistics';

/**
 * Derive the stored deviation statistics (#6872, #6833) from the Deviation
 * panel's held readback: the pooled and per-asset summaries once per
 * readback, the tolerance counts again only when the tolerance changes. A
 * result whose run was invalidated or re-run meanwhile is never adopted.
 */
export function useDeviationStatisticsDerivation(
  distances: DeviationDistances | null,
  tolerance: number,
  readRevisionRef: RefObject<number | null>,
  runStampRef: RefObject<AnalysisStamp | null>,
  clipRange: number,
): void {
  const summarizedRef = useRef<{ distances: DeviationDistances; summary: Pick<PointCloudDeviationStatistics, 'overall' | 'assets'> } | null>(null);
  useEffect(() => {
    // Dropping the readback also drops the summary cache that pins it (4 B/point).
    if (!distances) { summarizedRef.current = null; return; }
    const controller = new AbortController();
    const { signal } = controller;
    const revisionAt = readRevisionRef.current ?? useViewerStore.getState().pointCloudDeviationRevision;
    const stamp = runStampRef.current;
    const adopt = (record: PointCloudDeviationStatistics) => {
      const s = useViewerStore.getState();
      if (signal.aborted || !s.pointCloudDeviationComputed || s.pointCloudDeviationRevision !== revisionAt) return;
      s.setPointCloudDeviationStatistics(stamp ? stampAnalysisReport(record, stamp) : record);
    };
    void (async () => {
      let summary = summarizedRef.current?.distances === distances ? summarizedRef.current.summary : null;
      if (!summary) {
        summary = await summarizeDeviationRun(distances, { clipRange, signal });
        summarizedRef.current = { distances, summary };
        adopt({ revision: revisionAt, clipRange, ...summary, withinTolerance: null });
      }
      const withinTolerance = await countDeviationWithinTolerance(distances, tolerance, { signal });
      adopt({ revision: revisionAt, clipRange, ...summary, withinTolerance });
    })().catch((err: unknown) => {
      if (!signal.aborted) console.error('[DeviationPanel] statistics pass failed', err);
    });
    return () => controller.abort();
    // The refs are stable and read at run time; the readback and the tolerance drive the derivation.
  }, [distances, tolerance, readRevisionRef, runStampRef, clipRange]);
}
