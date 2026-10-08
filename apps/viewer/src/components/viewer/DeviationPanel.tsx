/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BIM ↔ scan deviation heatmap controls.
 *
 * Renders a "Compute Deviation" button when the scene has at least
 * one mesh and one point cloud. Once compute completes, exposes a
 * range slider + diverging-ramp legend; the splat shader's
 * deviation colour mode then visualises signed distance to the
 * nearest mesh surface. After each run the signed distances are read
 * back once for the summary statistics, histogram and CSV (#6872). The
 * statistics derived from that readback are stored
 * (`pointCloudDeviationStatistics`, #6833) so the summary, the CSV and the
 * assistant read one computation; the distances themselves stay here.
 *
 * Lives inside the `PointCloudPanel`; rendered conditionally on
 * `pointCloudAssetCount > 0`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviationDistances } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { placementSnapshot, placementSnapshotIsCurrent } from '@/lib/model-placement/placement-snapshot';
import { noteDeviationWrite } from '@/lib/model-placement/preview-analysis';
import { DEVIATION_RAMP_CSS_GRADIENT } from '@/lib/point-cloud/deviation-ramp';
import { countDeviationWithinTolerance, withToleranceShare } from '@/lib/point-cloud/deviation-run-statistics';
import { captureAnalysisStamp, type AnalysisStamp } from '@/hooks/useAnalysisStaleness';
import { buildDeviationCsvReport } from '@/lib/analysis/export-csv';
import { downloadFile } from '@/lib/export/download';
import { beginActivity, finishActivity } from '@/lib/activity/activity-journal';
import { trackExportCompleted } from '@/lib/analytics';
import { deviationAssetIdentities } from '@/lib/point-cloud/deviation-asset-identity';
import { cn } from '@/lib/utils';
import { DeviationHistogramBars } from './DeviationStatistics';
import { DeviationResultChrome } from './DeviationResultChrome';
import { useDeviationStatisticsDerivation } from './useDeviationStatisticsDerivation';

/** The compute pass pegs |d| here; the statistics count points at the peg. */
const DEVIATION_CLIP_RANGE_M = 1.0;
/** Initial "within tolerance" band, metres; the summary's input edits it. */
const DEFAULT_TOLERANCE_M = 0.01;

export interface DeviationPanelProps {
  /** Total number of triangles currently in the scene — gates the
   *  compute button on the existence of a BIM model. */
  triangleCount: number;
}

export function DeviationPanel({ triangleCount }: DeviationPanelProps) {
  const { t } = useTranslation();
  const halfRange = useViewerStore((s) => s.pointCloudDeviationHalfRange);
  const centerOffset = useViewerStore((s) => s.pointCloudDeviationCenterOffset);
  const setHalfRange = useViewerStore((s) => s.setPointCloudDeviationHalfRange);
  const computed = useViewerStore((s) => s.pointCloudDeviationComputed);
  const revision = useViewerStore((s) => s.pointCloudDeviationRevision);
  const setComputed = useViewerStore((s) => s.setPointCloudDeviationComputed);
  const colorMode = useViewerStore((s) => s.pointCloudColorMode);
  const setColorMode = useViewerStore((s) => s.setPointCloudColorMode);
  const statistics = useViewerStore((s) => s.pointCloudDeviationStatistics);
  const setStatistics = useViewerStore((s) => s.setPointCloudDeviationStatistics);

  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<{
    triangles: number;
    points: number;
    durationMs: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Signed distances read back once per run (#6872): 4 bytes per point, the
  // size of the GPU deviation buffers. Statistics and the CSV derive from it.
  const [distances, setDistances] = useState<DeviationDistances | null>(null);
  const [tolerance, setTolerance] = useState(() =>
    useViewerStore.getState().pointCloudDeviationStatistics?.withinTolerance?.tolerance ?? DEFAULT_TOLERANCE_M);
  // The analysis stamp of the run the held readback belongs to (#6833).
  const runStampRef = useRef<AnalysisStamp | null>(null);

  // Export is a sliced CPU pass over the held readback. While it runs,
  // Recompute stays disabled (the #5832 lock), and anything that replaces or
  // drops the readback aborts it, so a CSV never describes a stale run.
  const [exporting, setExporting] = useState(false);
  // Why the last Export CSV produced no file (#6880): no scan point was measured.
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const exportRef = useRef<{ distances: DeviationDistances; controller: AbortController } | null>(null);

  // A placement change, model removal or device loss clears `computed`; drop
  // the copy too (4 B/point), and stop an export reading it.
  useEffect(() => {
    if (!computed) setDistances(null);
  }, [computed]);
  useEffect(() => {
    const pending = exportRef.current;
    if (pending && pending.distances !== distances) pending.controller.abort();
    setExportNotice(null);
  }, [distances]);

  // COPC LOD streaming re-runs deviation on the chunks of each settled view
  // (#6880) and bumps the revision. The held readback then describes chunks
  // that are no longer drawn, so drop it and read the new run back.
  // Mounting on a computed run tracks its revision: stored statistics count as
  // read at the current revision, so a later COPC re-run reads back again, and
  // statistics dropped while the panel was closed (a re-run bumps the revision
  // whether or not the panel is mounted) are read back now (#6833).
  // A summary stored without its tolerance count (the panel closed mid-pass) is not fully read.
  const readRevisionRef = useRef<number | null>(computed ? (statistics?.withinTolerance ? revision : -1) : null);
  useEffect(() => {
    const readAt = readRevisionRef.current;
    if (!computed || running || readAt === null || readAt === revision) return;
    const renderer = getGlobalRenderer();
    if (!renderer) return;
    readRevisionRef.current = revision;
    runStampRef.current = captureAnalysisStamp(true);
    setDistances(null);
    let current = true;
    renderer.readDeviationDistances().then(
      (read) => {
        if (!current) return;
        // The run these statistics describe replaced the one an earlier
        // readback failed on: that failure (the renderer refuses a read the
        // moment a re-run starts, before the revision is announced) is stale.
        setError(null);
        setDistances(read);
      },
      // A newer refresh is already queued behind the run that raced this read.
      (err: unknown) => { if (current) console.warn('[DeviationPanel] statistics refresh failed', err); },
    );
    return () => { current = false; };
  }, [computed, running, revision]);

  useDeviationStatisticsDerivation(distances, tolerance, readRevisionRef, runStampRef, DEVIATION_CLIP_RANGE_M);

  const handleExport = useCallback(async () => {
    if (!computed || !distances || !statistics || running || exportRef.current) return;
    const controller = new AbortController();
    exportRef.current = { distances, controller };
    let cancelledFromTray = false;
    const job = beginActivity({ kind: 'export', title: 'activityTray.job.export', subject: 'CSV',
      cancel: () => { if (exportRef.current?.controller === controller) { cancelledFromTray = true; controller.abort(); } } });
    setExporting(true);
    setError(null);
    setExportNotice(null);
    const source = useViewerStore.getState();
    const sourceModels = source.models;
    try {
      // The stored summaries; only the tolerance band is counted for the export.
      const within = await countDeviationWithinTolerance(distances, tolerance, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const summaries = statistics.assets.map((asset, i) => ({
        ...asset, statistics: withToleranceShare(asset.statistics, tolerance, within.assets[i] ?? 0) }));
      // The pooled row is a pass over every point, never a mean of the rows.
      const overall = summaries.length > 1
        ? { name: t('deviationStats.csvAllAssetsName'), statistics: withToleranceShare(statistics.overall, tolerance, within.overall) }
        : null;
      if (useViewerStore.getState().models !== sourceModels) {
        throw new Error(t('deviationPanel.positionsChangedError'));
      }
      // One source for the whole row (#6887): the asset's global id resolved against the federation it was
      // read from, shared with the assistant's deviation evidence (#6833).
      const identities = deviationAssetIdentities(summaries, source);
      const assets = summaries.map((asset, i) => ({
        Model: identities[i].modelName ?? '',
        GlobalId: identities[i].globalId ?? '',
        Name: identities[i].name ?? '',
        IfcClass: identities[i].ifcClass ?? '',
        statistics: asset.statistics,
      }));
      const report = buildDeviationCsvReport({ assets, overall }, [...sourceModels.values()].map((model) => model.name));
      if (report) {
        downloadFile(report.content, report.filename, 'text/csv;charset=utf-8');
        trackExportCompleted({ format: 'csv', surface: 'deviation_panel', row_count: report.rows });
        finishActivity(job, 'completed');
      } else {
        // A COPC scan keeps only the nodes in view; with every node dropped
        // the run measured nothing, and an empty file would explain nothing.
        const notice = t('deviationPanel.exportNoPointsNotice');
        setExportNotice(notice);
        finishActivity(job, 'failed', { detail: notice });
      }
    } catch (err) {
      finishActivity(job, controller.signal.aborted ? 'cancelled' : 'failed',
        controller.signal.aborted ? {} : { detail: err instanceof Error ? err.message : String(err) });
      if (cancelledFromTray) setExportNotice(t('deviationPanel.exportCancelledNotice'));
      setError(controller.signal.aborted
        ? (cancelledFromTray ? null : t('deviationPanel.resultsChangedError'))
        : err instanceof Error ? err.message : String(err));
    } finally {
      if (exportRef.current?.controller === controller) exportRef.current = null;
      setExporting(false);
    }
  }, [computed, distances, statistics, running, t, tolerance]);

  const handleCompute = useCallback(async () => {
    if (exportRef.current) return;
    const renderer = getGlobalRenderer();
    if (!renderer) {
      setError(t('deviationPanel.rendererNotReadyError'));
      return;
    }
    setError(null);
    setDistances(null);
    setStatistics(null);
    setRunning(true);
    runStampRef.current = captureAnalysisStamp(true);
    const t0 = performance.now();
    const placement = placementSnapshot(useViewerStore.getState());
    let readingAt: number | null = null;
    try {
      noteDeviationWrite(renderer);
      const result = await renderer.computeDeviations({ maxRange: DEVIATION_CLIP_RANGE_M });
      if (!placementSnapshotIsCurrent(placement, useViewerStore.getState())) {
        setError(t('deviationPanel.positionsChangedError')); return;
      }
      const dt = performance.now() - t0;
      if (result.pointsProcessed === 0) {
        setError(t('deviationPanel.noPointsError'));
        setRunning(false);
        return;
      }
      if (result.bvhTriangles === 0) {
        setError(t('deviationPanel.noMeshError'));
        setRunning(false);
        return;
      }
      setStats({
        triangles: result.bvhTriangles,
        points: result.pointsProcessed,
        durationMs: dt,
      });
      setComputed(true);
      // Default-pick a sensible half-range from the BVH's bbox if the
      // user hasn't touched the slider yet (initial 5 cm is fine for
      // small models but useless for a city-block scan).
      if (halfRange === 0.05 && result.suggestedHalfRange !== 0.05) {
        setHalfRange(result.suggestedHalfRange);
      }
      // Auto-switch the colour mode to deviation so the user sees
      // the result immediately.
      setColorMode('deviation');
      // The heatmap is already on screen; the statistics follow the readback.
      readingAt = readRevisionRef.current = useViewerStore.getState().pointCloudDeviationRevision;
      const read = await renderer.readDeviationDistances();
      const after = useViewerStore.getState();
      // `computed` falls whenever the run is invalidated (placement, model
      // removal, device loss); a readback that outlived its run is dropped.
      if (!placementSnapshotIsCurrent(placement, after) || !after.pointCloudDeviationComputed) {
        setError(t('deviationPanel.positionsChangedError')); return;
      }
      setDistances(read);
    } catch (err) {
      // A COPC LOD re-run that landed during this readback superseded it
      // (#6880): the refresh below reads the new run, so this is not an error.
      if (readingAt !== null && useViewerStore.getState().pointCloudDeviationRevision !== readingAt) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [halfRange, setHalfRange, setColorMode, setComputed, setStatistics, t]);

  // Auto-compute when the user switches to the Deviation colour mode and a
  // result isn't ready. Selecting the mode alone only points the splat shader
  // at the per-point deviation buffer — which stays zero-initialised (→ every
  // point at the ramp centre, i.e. flat grey/white) until the compute pass
  // runs. Auto-running it makes "pick Deviation" actually show the heatmap.
  // Guarded by a ref so a failed compute doesn't retry-loop (the manual
  // button stays available); reset when leaving deviation mode.
  const autoComputedRef = useRef(false);
  useEffect(() => {
    if (colorMode !== 'deviation') {
      autoComputedRef.current = false;
      return;
    }
    if (!computed && !running && !autoComputedRef.current && triangleCount > 0) {
      autoComputedRef.current = true;
      void handleCompute();
    }
  }, [colorMode, computed, running, triangleCount, handleCompute]);

  // Hide the panel entirely when there's no BIM to compare against.
  // Point-cloud-only sessions (just a LAS / IFCx scan) have nothing
  // to deviate from so the button would always fail.
  if (triangleCount === 0) return null;

  return (
    <div className="flex flex-col gap-1 mt-1 pt-1 border-t border-border/40">
      <span className="text-2xs uppercase text-muted-foreground tracking-wider">
        {t('deviationPanel.sectionLabel')}
      </span>
      <button
        type="button"
        onClick={handleCompute}
        disabled={running || exporting}
        className={cn(
          'text-xs px-2 py-1 rounded transition-colors',
          running
            ? 'bg-muted text-muted-foreground'
            : 'bg-teal-600 text-white hover:bg-teal-500 disabled:opacity-50',
        )}
        title={t('deviationPanel.computeButtonTitle', { count: triangleCount.toLocaleString() })}
      >
        {running
          ? t('deviationPanel.computingLabel')
          : computed
            ? t('deviationPanel.recomputeLabel')
            : t('deviationPanel.computeLabel')}
      </button>
      {error && (
        <span className="text-2xs text-destructive">{error}</span>
      )}
      {stats && (
        <div className="text-2xs text-muted-foreground">
          {t('deviationPanel.statsLine', {
            points: stats.points.toLocaleString(),
            triangles: stats.triangles.toLocaleString(),
            duration: Math.round(stats.durationMs),
          })}
        </div>
      )}

      {/* Always mounted: some screen readers only announce changes inside a live region that already exists. */}
      <output data-testid="deviation-export-notice" className="text-2xs text-muted-foreground">{exportNotice}</output>
      {computed && (
        <DeviationResultChrome statistics={statistics} distancesPresent={distances !== null}
          tolerance={tolerance} onToleranceChange={setTolerance}
          actions={distances && statistics && (
            <button type="button" onClick={handleExport}
              disabled={running || exporting}
              className="text-xs px-2 py-1 rounded border border-border text-left hover:bg-accent">
              {exporting ? t('deviationPanel.exportingCsv') : t('deviationPanel.exportCsv')}
            </button>
          )}
          filters={<label className="flex items-center gap-2 mt-1">
            <span className="text-2xs text-muted-foreground w-12 shrink-0">
              {t('deviationPanel.sliderValueLabel', { value: (halfRange * 1000).toFixed(halfRange < 0.01 ? 1 : 0) })}
            </span>
            <input
              type="range"
              min={1}
              max={1000}
              step={1}
              value={Math.round(halfRange * 1000)}
              onChange={(e) => setHalfRange(Number(e.target.value) / 1000)}
              className="flex-1 h-1 accent-teal-600 cursor-pointer"
              title={t('deviationPanel.rangeSliderTitle')}
              aria-label={t('deviationPanel.rangeSliderAriaLabel')}
            />
          </label>}>
          {distances && <DeviationHistogramBars distances={distances} center={centerOffset} halfRange={halfRange} />}

          {/* Legend: blue → white → red gradient with labelled endpoints. */}
          <div
            className="h-2 rounded-sm border border-foreground/10 mt-0.5"
            style={{ background: DEVIATION_RAMP_CSS_GRADIENT }}
            aria-label={t('deviationPanel.rampAriaLabel')}
          />
          <div className="flex justify-between text-2xs text-muted-foreground">
            <span>{t('deviationPanel.legendMinLabel', { value: (halfRange * 1000).toFixed(0) })}</span>
            <span>0</span>
            <span>{t('deviationPanel.legendMaxLabel', { value: (halfRange * 1000).toFixed(0) })}</span>
          </div>

          {colorMode !== 'deviation' && (
            <button
              type="button"
              onClick={() => setColorMode('deviation')}
              className="text-2xs text-teal-600 hover:text-teal-500 underline text-left mt-0.5"
            >
              {t('deviationPanel.switchToDeviationButton')}
            </button>
          )}
        </DeviationResultChrome>
      )}
    </div>
  );
}
