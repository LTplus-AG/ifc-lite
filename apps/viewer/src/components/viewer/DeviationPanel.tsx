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
 * back once for the summary statistics, histogram and CSV (#6872).
 *
 * Lives inside the `PointCloudPanel`; rendered conditionally on
 * `pointCloudAssetCount > 0`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { computeDeviationStatisticsAsync, summarizeDeviationAssetsAsync, type DeviationDistances } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { placementSnapshot, placementSnapshotIsCurrent } from '@/lib/model-placement/placement-snapshot';
import { noteDeviationWrite } from '@/lib/model-placement/preview-analysis';
import { DEVIATION_RAMP_CSS_GRADIENT } from '@/lib/point-cloud/deviation-ramp';
import { buildDeviationCsvReport } from '@/lib/analysis/export-csv';
import { downloadFile } from '@/lib/export/download';
import { trackExportCompleted } from '@/lib/analytics';
import { cn } from '@/lib/utils';
import { DeviationHistogramBars, DeviationSummary } from './DeviationStatistics';

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
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE_M);

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
  const readRevisionRef = useRef<number | null>(null);
  useEffect(() => {
    const readAt = readRevisionRef.current;
    if (!computed || running || readAt === null || readAt === revision) return;
    const renderer = getGlobalRenderer();
    if (!renderer) return;
    readRevisionRef.current = revision;
    setDistances(null);
    let current = true;
    renderer.readDeviationDistances().then(
      (read) => { if (current) setDistances(read); },
      // A newer refresh is already queued behind the run that raced this read.
      (err: unknown) => { if (current) console.warn('[DeviationPanel] statistics refresh failed', err); },
    );
    return () => { current = false; };
  }, [computed, running, revision]);

  const handleExport = useCallback(async () => {
    if (!computed || !distances || running || exportRef.current) return;
    const controller = new AbortController();
    exportRef.current = { distances, controller };
    setExporting(true);
    setError(null);
    setExportNotice(null);
    const source = useViewerStore.getState();
    const sourceModels = source.models;
    try {
      const options = { tolerance, clipRange: DEVIATION_CLIP_RANGE_M, signal: controller.signal };
      const summaries = await summarizeDeviationAssetsAsync(distances, options);
      // The pooled row is a pass over every point, never a mean of the rows.
      const overall = summaries.length > 1
        ? { name: t('deviationStats.csvAllAssetsName'), statistics: await computeDeviationStatisticsAsync(distances.values, options) }
        : null;
      if (useViewerStore.getState().models !== sourceModels) {
        throw new Error(t('deviationPanel.positionsChangedError'));
      }
      // One source for the whole row (#6887): the asset's global id resolved
      // against the federation it was read from. The model AND its entity come
      // from the same lookup, so they cannot disagree. Not `resolveEntityRef`:
      // its first-model fallback would name a model for an id no model owns.
      const assets = summaries.map((asset) => {
        const ref = source.resolveGlobalIdFromModels(asset.expressId);
        const model = ref ? sourceModels.get(ref.modelId) : undefined;
        const entities = model?.ifcDataStore?.entities;
        return {
          Model: model?.name ?? '',
          GlobalId: (ref && entities?.getGlobalId(ref.expressId)) || '',
          Name: (ref && entities?.getName(ref.expressId)) || '',
          IfcClass: (ref && entities?.getTypeName(ref.expressId)) || '',
          statistics: asset.statistics,
        };
      });
      const report = buildDeviationCsvReport({ assets, overall }, [...sourceModels.values()].map((model) => model.name));
      if (report) {
        downloadFile(report.content, report.filename, 'text/csv;charset=utf-8');
        trackExportCompleted({ format: 'csv', surface: 'deviation_panel', row_count: report.rows });
      } else {
        // A COPC scan keeps only the nodes in view; with every node dropped
        // the run measured nothing, and an empty file would explain nothing.
        setExportNotice(t('deviationPanel.exportNoPointsNotice'));
      }
    } catch (err) {
      setError(controller.signal.aborted
        ? t('deviationPanel.resultsChangedError')
        : err instanceof Error ? err.message : String(err));
    } finally {
      exportRef.current = null;
      setExporting(false);
    }
  }, [computed, distances, running, t, tolerance]);

  const handleCompute = useCallback(async () => {
    if (exportRef.current) return;
    const renderer = getGlobalRenderer();
    if (!renderer) {
      setError(t('deviationPanel.rendererNotReadyError'));
      return;
    }
    setError(null);
    setDistances(null);
    setRunning(true);
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
  }, [halfRange, setHalfRange, setColorMode, setComputed, t]);

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

      {exportNotice && (
        <span role="status" data-testid="deviation-export-notice" className="text-2xs text-muted-foreground">{exportNotice}</span>
      )}
      {computed && distances && (
        <button type="button" onClick={handleExport}
          disabled={running || exporting}
          className="text-xs px-2 py-1 rounded border border-border text-left hover:bg-accent">
          {exporting ? t('deviationPanel.exportingCsv') : t('deviationPanel.exportCsv')}
        </button>
      )}

      {computed && (
        <>
          {/* Range slider: half-width in mm. Range from 1 mm to 1 m
              (logarithmic feel via the millimetre conversion). */}
          <label className="flex items-center gap-2 mt-1">
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
          </label>

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

          {distances && (
            <DeviationSummary
              distances={distances}
              tolerance={tolerance}
              onToleranceChange={setTolerance}
              clipRange={DEVIATION_CLIP_RANGE_M}
            />
          )}

          {colorMode !== 'deviation' && (
            <button
              type="button"
              onClick={() => setColorMode('deviation')}
              className="text-2xs text-teal-600 hover:text-teal-500 underline text-left mt-0.5"
            >
              {t('deviationPanel.switchToDeviationButton')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
