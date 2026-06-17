/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sun & Sky panel — one place for sky, lighting and the sun-path study,
 * aware of which rendering path is active:
 *
 *   • Standalone (WebGPU): lighting preset + exposure shape the model's
 *     shading, Sky draws the procedural sky, and the sun study (when the
 *     model is georeferenced) drives the real sun direction.
 *   • World context (Cesium): the model is composited into Cesium, which
 *     lights the scene from its sun and atmosphere — so preset/exposure
 *     hide and Sky toggles the atmosphere instead. The study adds the
 *     sun-path dome and real cast shadows.
 *
 * The whole panel collapses to its header row; the study keeps running
 * (sweep animation lives in useSolarSweep at the viewport level).
 */

import { useRef, useState } from 'react';
import { Play, Pause, ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useDraggablePanel } from '@/hooks/useDraggablePanel';
import { cn } from '@/lib/utils';
import type { CesiumDataSource } from '@/store/slices/cesiumSlice';
import type { SolarSweepMode } from '@/store/slices/solarSlice';
import { LIGHTING_PRESETS, LIGHTING_PRESET_ORDER, isLightingPresetId } from '@/lib/lighting-presets';
import {
  solarDisplayOffsetMinutes,
  toSolarDateInputValue,
  solarMinutesOfDay,
  composeSolarMs,
  formatSolarTime,
} from '@/lib/solar-time';

const CONTEXT_SOURCES: Array<{ value: CesiumDataSource; label: string; hint: string }> = [
  { value: 'osm-buildings', label: 'OSM Buildings', hint: 'Extruded footprints over the satellite base map' },
  { value: 'google-photorealistic', label: 'Photorealistic', hint: 'Google 3D Tiles — textured real-world context' },
];

const SWEEP_MODES: Array<{ value: SolarSweepMode; label: string; hint: string }> = [
  { value: 'day', label: 'Day', hint: 'Sweep the time of day' },
  { value: 'year', label: 'Year', hint: 'Sweep the date across the year' },
];

export function SunSkyPanel() {
  const open = useViewerStore((s) => s.envPanelOpen);

  const skyEnabled = useViewerStore((s) => s.envSkyEnabled);
  const setSkyEnabled = useViewerStore((s) => s.setEnvSkyEnabled);
  const preset = useViewerStore((s) => s.envPreset);
  const setPreset = useViewerStore((s) => s.setEnvPreset);
  const exposure = useViewerStore((s) => s.envExposure);
  const setExposure = useViewerStore((s) => s.setEnvExposure);

  const cesiumAvailable = useViewerStore((s) => s.cesiumAvailable);
  const cesiumEnabled = useViewerStore((s) => s.cesiumEnabled);
  const setCesiumEnabled = useViewerStore((s) => s.setCesiumEnabled);
  const dataSource = useViewerStore((s) => s.cesiumDataSource);
  const setDataSource = useViewerStore((s) => s.setCesiumDataSource);

  const solarEnabled = useViewerStore((s) => s.solarEnabled);
  const setSolarEnabled = useViewerStore((s) => s.setSolarEnabled);
  const dateMs = useViewerStore((s) => s.solarDateMs);
  const setDateMs = useViewerStore((s) => s.setSolarDateMs);
  const showSunPath = useViewerStore((s) => s.solarShowSunPath);
  const setShowSunPath = useViewerStore((s) => s.setSolarShowSunPath);
  const showShadows = useViewerStore((s) => s.solarShowShadows);
  const setShowShadows = useViewerStore((s) => s.setSolarShowShadows);
  const sunInfo = useViewerStore((s) => s.solarSunInfo);
  const useLocalTime = useViewerStore((s) => s.solarUseLocalTime);
  const setUseLocalTime = useViewerStore((s) => s.setSolarUseLocalTime);
  const playing = useViewerStore((s) => s.solarPlaying);
  const togglePlaying = useViewerStore((s) => s.toggleSolarPlaying);
  const sweepMode = useViewerStore((s) => s.solarSweepMode);
  const setSweepMode = useViewerStore((s) => s.setSolarSweepMode);

  const [collapsed, setCollapsed] = useState(false);
  // Hooks must run unconditionally — keep these ABOVE the `!open` early return
  // (a conditional hook is React error #310).
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useDraggablePanel(panelRef);

  if (!open) return null;

  const offsetMin = solarDisplayOffsetMinutes(useLocalTime, sunInfo?.longitude);
  const minutes = solarMinutesOfDay(dateMs, offsetMin);
  const tzLabel = useLocalTime
    ? `Site${sunInfo ? ` (UTC${offsetMin >= 0 ? '+' : '−'}${Math.abs(offsetMin / 60).toFixed(1)})` : ''}`
    : 'UTC';

  return (
    <div
      ref={panelRef}
      style={drag.style}
      className="pointer-events-auto absolute top-32 right-4 z-10 w-60 bg-background/90 backdrop-blur-sm rounded-lg border shadow-lg p-2 flex flex-col gap-2 text-xs"
    >
      {/* Header: the grip drags (issue #1107); the rest toggles collapse —
          kept separate so the two affordances don't collide. */}
      <div className="flex items-center gap-1.5">
        <span
          onMouseDown={drag.onDragStart}
          title="Drag to move"
          className="shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          className="flex-1 flex items-center justify-between gap-2 text-left"
        >
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Sun &amp; Sky
          </span>
          <span className="text-muted-foreground">
            {collapsed ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
          </span>
        </button>
      </div>

      {!collapsed && (
        <>
          {/* Environment — the preset IS the whole look: every preset except
              Default brings its own sky. In the world context the model is
              lit by Cesium's sun instead, so the choice becomes a single
              Atmosphere switch. */}
          {cesiumEnabled ? (
            <div className="flex items-center gap-1">
              <ToggleChip
                label="Atmosphere"
                active={skyEnabled}
                onClick={() => setSkyEnabled(!skyEnabled)}
                title="Sky, sun disc and haze in the world context"
              />
              <span className="flex-1 px-1 text-[9px] leading-tight text-muted-foreground">
                Lighting follows the sun &amp; atmosphere
              </span>
            </div>
          ) : (
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Environment</span>
              <select
                aria-label="Environment preset"
                value={preset}
                onChange={(e) => { if (isLightingPresetId(e.target.value)) setPreset(e.target.value); }}
                title={LIGHTING_PRESETS[preset].hint}
                className="w-full bg-muted/40 rounded px-1.5 py-1 border text-foreground text-[10px]"
              >
                {LIGHTING_PRESET_ORDER.map((id) => (
                  <option key={id} value={id}>
                    {LIGHTING_PRESETS[id].label}{id === 'default' ? ' (no sky)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          {/* Exposure — WebGPU shading only, hidden in world-context mode */}
          {!cesiumEnabled && (
            <label className="flex flex-col gap-0.5">
              <span className="flex justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
                <span>Exposure</span>
                <button
                  type="button"
                  onClick={() => setExposure(1)}
                  title="Reset exposure"
                  className={cn('tabular-nums transition-colors', exposure !== 1 && 'text-foreground hover:text-teal-600')}
                >
                  {exposure.toFixed(2)}×
                </button>
              </span>
              <input
                type="range"
                min={0.4}
                max={2}
                step={0.05}
                value={exposure}
                onChange={(e) => setExposure(Number(e.target.value))}
                className="w-full accent-teal-600"
              />
            </label>
          )}

          {/* Sun study — needs a georeferenced model for the real sun */}
          {cesiumAvailable && (
            <>
              <div className="flex items-center justify-between gap-2 pt-2 border-t">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Sun study
                </span>
                <button
                  type="button"
                  aria-pressed={solarEnabled}
                  onClick={() => setSolarEnabled(!solarEnabled)}
                  className={cn(
                    'px-2 py-0.5 rounded text-[10px] font-semibold uppercase transition-colors',
                    solarEnabled ? 'bg-amber-500 text-zinc-950' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {solarEnabled ? 'On' : 'Off'}
                </button>
              </div>

              {solarEnabled && (
                <>
                  {/* Date + play/pause */}
                  <div className="flex items-end gap-1.5">
                    {/* Not a <label>: the tz toggle is interactive, so wrapping the
                        input in a label would forward tz clicks to the date picker. */}
                    <div className="flex flex-col gap-0.5 flex-1">
                      <span className="flex justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
                        <span>Date</span>
                        <button
                          type="button"
                          onClick={() => setUseLocalTime(!useLocalTime)}
                          title="Toggle UTC / local solar time (from site longitude)"
                          className="hover:text-foreground transition-colors"
                        >
                          {tzLabel}
                        </button>
                      </span>
                      <input
                        type="date"
                        aria-label="Sun study date"
                        value={toSolarDateInputValue(dateMs, offsetMin)}
                        onChange={(e) => setDateMs(composeSolarMs(e.target.value, minutes, offsetMin))}
                        className="w-full bg-muted/40 rounded px-1.5 py-1 border text-foreground"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={togglePlaying}
                      aria-label={playing ? 'Pause sweep' : 'Play sweep'}
                      aria-pressed={playing}
                      className={cn(
                        'h-[26px] w-[26px] flex items-center justify-center rounded transition-colors shrink-0',
                        playing ? 'bg-teal-600 text-white' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    </button>
                  </div>

                  {/* Time of day */}
                  <label className="flex flex-col gap-0.5">
                    <span className="flex justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
                      <span>Time</span>
                      <span className="tabular-nums text-foreground">{formatSolarTime(dateMs, offsetMin)}</span>
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={1439}
                      step={5}
                      value={minutes}
                      onChange={(e) => setDateMs(composeSolarMs(toSolarDateInputValue(dateMs, offsetMin), Number(e.target.value), offsetMin))}
                      className="w-full accent-teal-600"
                    />
                  </label>

                  {/* Sweep mode */}
                  <div className="flex gap-1">
                    {SWEEP_MODES.map((m) => (
                      <button
                        key={m.value}
                        type="button"
                        title={m.hint}
                        aria-pressed={sweepMode === m.value}
                        onClick={() => setSweepMode(m.value)}
                        className={cn(
                          'flex-1 px-1.5 py-1 rounded text-[10px] transition-colors',
                          sweepMode === m.value
                            ? 'bg-teal-600 text-white'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>

                  {/* World-context extras: dome + shadows + context source */}
                  {cesiumEnabled ? (
                    <>
                      <div className="flex gap-1">
                        <ToggleChip className="flex-1" label="Dome" active={showSunPath} onClick={() => setShowSunPath(!showSunPath)} />
                        <ToggleChip className="flex-1" label="Shadows" active={showShadows} onClick={() => setShowShadows(!showShadows)} />
                      </div>
                      <div className="flex gap-1">
                        {CONTEXT_SOURCES.map((src) => (
                          <button
                            key={src.value}
                            type="button"
                            title={src.hint}
                            aria-pressed={dataSource === src.value}
                            onClick={() => setDataSource(src.value)}
                            className={cn(
                              'flex-1 px-1.5 py-1 rounded text-[10px] transition-colors',
                              dataSource === src.value
                                ? 'bg-teal-600 text-white'
                                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                            )}
                          >
                            {src.label}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setCesiumEnabled(true)}
                      className="text-left text-[9px] leading-snug text-muted-foreground hover:text-foreground transition-colors"
                    >
                      The sun lights the model directly; for the sun-path dome and
                      real cast shadows, click to enable the 3D world context.
                    </button>
                  )}

                  {!sunInfo && (
                    <p className="text-[9px] leading-snug text-amber-600 dark:text-amber-500">
                      Site location unavailable — the model's projected CRS
                      could not be resolved, so the real sun position can't be
                      computed.
                    </p>
                  )}

                  {/* Readout */}
                  <div className="mt-1 pt-2 border-t grid grid-cols-2 gap-x-2 gap-y-0.5 tabular-nums">
                    <Readout label="Azimuth" value={sunInfo ? `${sunInfo.azimuth.toFixed(1)}°` : '—'} />
                    <Readout label="Altitude" value={sunInfo ? `${sunInfo.altitude.toFixed(1)}°` : '—'} />
                    <Readout label="Sunrise" value={formatSolarTime(sunInfo?.sunriseMs ?? null, offsetMin)} />
                    <Readout label="Sunset" value={formatSolarTime(sunInfo?.sunsetMs ?? null, offsetMin)} />
                    <Readout label="Noon" value={formatSolarTime(sunInfo?.solarNoonMs ?? null, offsetMin)} />
                    <Readout
                      label="Site"
                      value={sunInfo ? `${sunInfo.latitude.toFixed(2)}, ${sunInfo.longitude.toFixed(2)}` : '—'}
                    />
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Small pill toggle button. */
function ToggleChip({ label, active, onClick, title, className }: {
  label: string; active: boolean; onClick: () => void; title?: string; className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={cn(
        'px-2 py-1 rounded text-[10px] font-semibold uppercase transition-colors',
        active ? 'bg-teal-600 text-white' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        className,
      )}
    >
      {label}
    </button>
  );
}

/** One label/value cell in the sun readout grid. */
function Readout({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right text-foreground">{value}</span>
    </>
  );
}
