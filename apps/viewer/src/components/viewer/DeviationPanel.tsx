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
 * nearest mesh surface.
 *
 * Lives inside the `PointCloudPanel`; rendered conditionally on
 * `pointCloudAssetCount > 0`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { placementSnapshot, placementSnapshotIsCurrent } from '@/lib/model-placement/placement-snapshot';
import { noteDeviationWrite } from '@/lib/model-placement/preview-analysis';
import { DEVIATION_RAMP_CSS_GRADIENT } from '@/lib/point-cloud/deviation-ramp';
import { cn } from '@/lib/utils';

export interface DeviationPanelProps {
  /** Total number of triangles currently in the scene — gates the
   *  compute button on the existence of a BIM model. */
  triangleCount: number;
}

export function DeviationPanel({ triangleCount }: DeviationPanelProps) {
  const { t } = useTranslation();
  const halfRange = useViewerStore((s) => s.pointCloudDeviationHalfRange);
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

  const handleCompute = useCallback(async () => {
    const renderer = getGlobalRenderer();
    if (!renderer) {
      setError(t('deviationPanel.rendererNotReadyError'));
      return;
    }
    setError(null);
    setRunning(true);
    const t0 = performance.now();
    const placement = placementSnapshot(useViewerStore.getState());
    try {
      noteDeviationWrite(renderer);
      const result = await renderer.computeDeviations({ maxRange: 1.0 });
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
      <span className="text-[9px] uppercase text-muted-foreground tracking-wider">
        {t('deviationPanel.sectionLabel')}
      </span>
      <button
        type="button"
        onClick={handleCompute}
        disabled={running}
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
        <span className="text-[10px] text-destructive">{error}</span>
      )}
      {stats && (
        <div className="text-[10px] text-muted-foreground">
          {t('deviationPanel.statsLine', {
            points: stats.points.toLocaleString(),
            triangles: stats.triangles.toLocaleString(),
            duration: Math.round(stats.durationMs),
          })}
        </div>
      )}

      {computed && (
        <>
          {/* Range slider: half-width in mm. Range from 1 mm to 1 m
              (logarithmic feel via the millimetre conversion). */}
          <label className="flex items-center gap-2 mt-1">
            <span className="text-[10px] text-muted-foreground w-12 shrink-0">
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

          {/* Legend: blue → white → red gradient with labelled endpoints. */}
          <div
            className="h-2 rounded-sm border border-foreground/10 mt-0.5"
            style={{ background: DEVIATION_RAMP_CSS_GRADIENT }}
            aria-label={t('deviationPanel.rampAriaLabel')}
          />
          <div className="flex justify-between text-[9px] text-muted-foreground">
            <span>{t('deviationPanel.legendMinLabel', { value: (halfRange * 1000).toFixed(0) })}</span>
            <span>0</span>
            <span>{t('deviationPanel.legendMaxLabel', { value: (halfRange * 1000).toFixed(0) })}</span>
          </div>

          {colorMode !== 'deviation' && (
            <button
              type="button"
              onClick={() => setColorMode('deviation')}
              className="text-[10px] text-teal-600 hover:text-teal-500 underline text-left mt-0.5"
            >
              {t('deviationPanel.switchToDeviationButton')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
