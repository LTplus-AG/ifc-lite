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

import { useCallback, useState } from 'react';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { cn } from '@/lib/utils';

export interface DeviationPanelProps {
  /** Total number of triangles currently in the scene — gates the
   *  compute button on the existence of a BIM model. */
  triangleCount: number;
}

export function DeviationPanel({ triangleCount }: DeviationPanelProps) {
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
      setError('Renderer not initialised yet.');
      return;
    }
    setError(null);
    setRunning(true);
    const t0 = performance.now();
    try {
      const result = await renderer.computeDeviations({ maxRange: 1.0 });
      const dt = performance.now() - t0;
      if (result.pointsProcessed === 0) {
        setError('No points processed — load a point cloud first.');
        setRunning(false);
        return;
      }
      if (result.bvhTriangles === 0) {
        setError('No mesh geometry in the scene — load an IFC first.');
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
  }, [halfRange, setHalfRange, setColorMode, setComputed]);

  // Hide the panel entirely when there's no BIM to compare against.
  // Point-cloud-only sessions (just a LAS / IFCx scan) have nothing
  // to deviate from so the button would always fail.
  if (triangleCount === 0) return null;

  return (
    <div className="flex flex-col gap-1 mt-1 pt-1 border-t border-border/40">
      <span className="text-[9px] uppercase text-muted-foreground tracking-wider">
        Deviation (BIM ↔ scan)
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
        title={`Build BVH from ${triangleCount.toLocaleString()} triangles, then signed-distance every loaded point against the nearest surface`}
      >
        {running ? 'Computing…' : computed ? 'Recompute' : 'Compute deviation'}
      </button>
      {error && (
        <span className="text-[10px] text-destructive">{error}</span>
      )}
      {stats && (
        <div className="text-[10px] text-muted-foreground">
          {stats.points.toLocaleString()} pts vs.{' '}
          {stats.triangles.toLocaleString()} tris in{' '}
          {Math.round(stats.durationMs)} ms
        </div>
      )}

      {computed && (
        <>
          {/* Range slider: half-width in mm. Range from 1 mm to 1 m
              (logarithmic feel via the millimetre conversion). */}
          <label className="flex items-center gap-2 mt-1">
            <span className="text-[10px] text-muted-foreground w-12 shrink-0">
              ±{(halfRange * 1000).toFixed(halfRange < 0.01 ? 1 : 0)}mm
            </span>
            <input
              type="range"
              min={1}
              max={1000}
              step={1}
              value={Math.round(halfRange * 1000)}
              onChange={(e) => setHalfRange(Number(e.target.value) / 1000)}
              className="flex-1 h-1 accent-teal-600 cursor-pointer"
              title="Deviation half-range in millimetres — values past ±this map to the ramp endpoints"
              aria-label="Deviation range half-width"
            />
          </label>

          {/* Legend: blue → white → red gradient with labelled endpoints. */}
          <div
            className="h-2 rounded-sm border border-foreground/10 mt-0.5"
            style={{
              background: 'linear-gradient(to right, rgb(26,77,217), rgb(242,242,242), rgb(217,51,26))',
            }}
            aria-label="Deviation ramp from negative (blue) to positive (red)"
          />
          <div className="flex justify-between text-[9px] text-muted-foreground">
            <span>−{(halfRange * 1000).toFixed(0)}mm (inside)</span>
            <span>0</span>
            <span>+{(halfRange * 1000).toFixed(0)}mm (outside)</span>
          </div>

          {colorMode !== 'deviation' && (
            <button
              type="button"
              onClick={() => setColorMode('deviation')}
              className="text-[10px] text-teal-600 hover:text-teal-500 underline text-left mt-0.5"
            >
              Switch colour mode to Deviation
            </button>
          )}
        </>
      )}
    </div>
  );
}
