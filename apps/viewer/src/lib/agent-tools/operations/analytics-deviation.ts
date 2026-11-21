/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { captureAnalysisStamp, stampAnalysisReport, isAnalysisStale, analysisStampOf } from '@/hooks/useAnalysisStaleness';
import { computeNativeDeviation } from '@/lib/point-cloud/compute-native-deviation';
import { summarizeDeviationRun, countDeviationWithinTolerance, withToleranceShare, type PointCloudDeviationStatistics } from '@/lib/point-cloud/deviation-run-statistics';
import { captureDeviationSource, recordDeviationSource, deviationSourceOf } from '@/lib/point-cloud/deviation-source';
import { placementSnapshot, placementSnapshotIsCurrent } from '@/lib/model-placement/placement-snapshot';
import { buildDeviationCsvReport } from '@/lib/analysis/export-csv';
import { operation, emptySchema } from './contract';
import { metadata, artifactSchema, checkpoint } from './analytics-common';
import { stale, unavailable } from './refusals';
const output = { type: 'object', properties: { revision: { type: 'integer' }, clipRange: { type: 'number' }, overall: { type: 'object' }, assets: { type: 'array' }, withinTolerance: { type: ['object', 'null'] } }, required: ['revision', 'clipRange', 'overall', 'assets', 'withinTolerance'], additionalProperties: false };
function statistics() {
  const s = useViewerStore.getState(); const report = s.pointCloudDeviationStatistics;
  if (!s.pointCloudDeviationComputed || !report || report.revision !== s.pointCloudDeviationRevision || isAnalysisStale(analysisStampOf(report), s)) throw unavailable('No current native deviation statistics are available. Run the native analysis first.');
  return report;
}
export const analyticsDeviationOperations = [
  operation<{ tolerance_metres: number }>(metadata('pointclouds.computeDeviation', 'pointclouds', 'Await the shared native GPU BIM/scan deviation pass, readback and sliced pooled/per-asset statistics. Cancellation is honored before GPU dispatch; admitted GPU work is non-cancellable and its completion is awaited.', ['read', 'view', 'configuration'], output), {
    type: 'object', properties: { tolerance_metres: { type: 'number', minimum: 0, maximum: 1 } }, required: ['tolerance_metres'], additionalProperties: false,
  } satisfies JSONSchemaType<{ tolerance_metres: number }>, async (i, c) => {
    const renderer = getGlobalRenderer(); if (!renderer) throw unavailable('The native GPU renderer is not available.');
    if (!useViewerStore.getState().pointCloudAssetCount) throw unavailable('Load a native point-cloud asset first.');
    const stamp = captureAnalysisStamp(true); const placement = placementSnapshot(useViewerStore.getState()); checkpoint(c);
    return c.commitAsync(async () => {
      c.progress?.({ phase: 'GPU deviation', done: 0, total: 3 });
      const { read, revision } = await computeNativeDeviation(renderer, 1);
      const source = captureDeviationSource(read.assets, stamp);
      c.progress?.({ phase: 'Readback statistics', done: 1, total: 3 });
      const summary = await summarizeDeviationRun(read, { clipRange: 1 });
      const withinTolerance = await countDeviationWithinTolerance(read, i.tolerance_metres);
      const s = useViewerStore.getState();
      if (isAnalysisStale(stamp, s) || !placementSnapshotIsCurrent(placement, s) || s.pointCloudDeviationRevision !== revision || !s.pointCloudDeviationComputed) throw stale('Native deviation was superseded or model placement changed during analysis.');
      const report: PointCloudDeviationStatistics = recordDeviationSource(stampAnalysisReport({ revision, clipRange: 1, ...summary, withinTolerance }, stamp), source);
      s.setPointCloudDeviationStatistics(report); c.progress?.({ phase: 'Completed', done: 3, total: 3 }); return report;
    });
  }),
  operation(metadata('pointclouds.deviationStatistics', 'pointclouds', 'Read current native deviation statistics with invalidated/replaced-run refusal.', ['read'], output), emptySchema, statistics),
  operation(metadata('pointclouds.exportDeviation', 'pointclouds', 'Export completed native per-asset/pooled deviation statistics with their captured model provenance and tolerance using the same safe CSV report writer as the panel.', ['read', 'artifact'], artifactSchema), emptySchema, async (_, c) => {
    const report = statistics(); const source = deviationSourceOf(report); const within = report.withinTolerance;
    if (!source || !within) throw unavailable('Native run provenance or tolerance computation is incomplete.');
    const assets = report.assets.map((asset, index) => ({ Model: source[index]?.modelName ?? '', GlobalId: source[index]?.globalId ?? '', Name: source[index]?.name ?? '', IfcClass: source[index]?.ifcClass ?? '', statistics: withToleranceShare(asset.statistics, within.tolerance, within.assets[index] ?? 0) }));
    const overall = assets.length > 1 ? { name: 'All assets', statistics: withToleranceShare(report.overall, within.tolerance, within.overall) } : null;
    const csv = buildDeviationCsvReport({ assets, overall }, [...new Set(source.flatMap(row => row.modelName ? [row.modelName] : []))]);
    if (!csv) throw unavailable('The native deviation run contains no valid exportable points.'); checkpoint(c);
    return c.artifacts.create({ filename: csv.filename, mimeType: 'text/csv;charset=utf-8', data: csv.content });
  }),
];
