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
import { modelIndices } from '@/lib/model-placement/model-indices';
import { resolveEntityRef } from '@/store/resolveEntityRef';
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
  const exportRef = useRef<{ distances: DeviationDistances; controller: AbortController } | null>(null);

  // A placement change, model removal or device loss clears `computed`; drop
  // the copy too (4 B/point), and stop an export reading it.
  useEffect(() => {
    if (!computed) setDistances(null);
  }, [computed]);
  useEffect(() => {
    const pending = exportRef.current;
    if (pending && pending.distances !== distances) pending.controller.abort();
  }, [distances]);

  const handleExport = useCallback(async () => {
    if (!computed || !distances || running || exportRef.current) return;
    const controller = new AbortController();
    exportRef.current = { distances, controller };
    setExporting(true);
    setError(null);
    const sourceModels = useViewerStore.getState().models;
    const idsByIndex = new Map([...modelIndices(sourceModels)].map(([id, index]) => [index, id]));
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
      const assets = summaries.map((asset) => {
        const modelId = idsByIndex.get(asset.modelIndex);
        const model = modelId ? sourceModels.get(modelId) : undefined;
        const ref = resolveEntityRef(asset.expressId);
        const entities = ref.modelId === modelId ? model?.ifcDataStore?.entities : undefined;
        return {
          Model: model?.name ?? '',
          GlobalId: entities?.getGlobalId(ref.expressId) ?? '',
          Name: entities?.getName(ref.expressId) ?? '',
          IfcClass: entities?.getTypeName(ref.expressId) ?? '',
          statistics: asset.statistics,
        };
      });
      const report = buildDeviationCsvReport({ assets, overall }, [...sourceModels.values()].map((model) => model.name));
      if (report) {
        downloadFile(report.content, report.filename, 'text/csv;charset=utf-8');
        trackExportCompleted({ format: 'csv', surface: 'deviation_panel', row_count: report.rows });
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
      const read = await renderer.readDeviationDistances();
      const after = useViewerStore.getState();
      // `computed` falls whenever the run is invalidated (placement, model
      // removal, device loss); a readback that outlived its run is dropped.
      if (!placementSnapshotIsCurrent(placement, after) || !after.pointCloudDeviationComputed) {
        setError(t('deviationPanel.positionsChangedError')); return;
      }
      setDistances(read);
    } catch (err) {
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
