/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Solar study panel — controls the georeferenced 3D sun-path dome + shadow
 * study rendered in the Cesium context overlay.
 *
 * Renders only when the loaded model is georeferenced (`cesiumAvailable`),
 * because the study relies on the model's real-world site for sun position
 * and on Cesium for the OSM/photorealistic context that casts shadows.
 *
 * Time handling: the studied instant is always stored as an absolute UTC
 * epoch. For display the panel defaults to *local solar time* derived from the
 * site longitude (15°/hour) — civil-timezone-agnostic on purpose, since
 * sun-path studies care about solar time and a longitude offset needs no
 * timezone database or DST rules. The user can switch the readout to UTC.
 */

import { useEffect, useRef } from 'react';
import { Play, Pause } from 'lucide-react';
import { useViewerStore } from '@/store';
import { cn } from '@/lib/utils';
import type { CesiumDataSource } from '@/store/slices/cesiumSlice';
import type { SolarSweepMode } from '@/store/slices/solarSlice';

const MS_PER_MIN = 60_000;
const MS_PER_DAY = 86_400_000;

/** Longitude → display offset in minutes (local solar time), or 0 for UTC. */
function offsetMinutesFor(useLocal: boolean, longitude: number | undefined): number {
  if (!useLocal || longitude === undefined) return 0;
  return Math.round((longitude / 15) * 60);
}

/** Epoch ms shifted into the display frame (UTC + offset). */
function toDisplay(ms: number, offsetMin: number): Date {
  return new Date(ms + offsetMin * MS_PER_MIN);
}

/** "YYYY-MM-DD" of the display-frame day for an instant. */
function toDateInputValue(ms: number, offsetMin: number): string {
  const d = toDisplay(ms, offsetMin);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

/** Minutes since midnight in the display frame. */
function minutesOfDay(ms: number, offsetMin: number): number {
  const d = toDisplay(ms, offsetMin);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Compose an absolute UTC epoch from a display-frame date string + minutes. */
function composeMs(dateStr: string, minutes: number, offsetMin: number): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  const displayMs = Date.UTC(y, (m ?? 1) - 1, d ?? 1, Math.floor(minutes / 60), minutes % 60, 0);
  return displayMs - offsetMin * MS_PER_MIN;
}

/** Epoch ms → "HH:MM" in the display frame. */
function formatTime(ms: number | null, offsetMin: number): string {
  if (ms === null) return '—';
  const d = toDisplay(ms, offsetMin);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

const CONTEXT_SOURCES: Array<{ value: CesiumDataSource; label: string; hint: string }> = [
  { value: 'osm-buildings', label: 'OSM Buildings', hint: 'Grey extruded footprints — classic massing context' },
  { value: 'google-photorealistic', label: 'Photorealistic', hint: 'Google 3D Tiles — textured real-world context' },
];

const SWEEP_MODES: Array<{ value: SolarSweepMode; label: string; hint: string }> = [
  { value: 'day', label: 'Day', hint: 'Sweep the time of day' },
  { value: 'year', label: 'Year', hint: 'Sweep the date across the year' },
];

/** Wall-clock cadence for the animation sweep. */
const TICK_MS = 80;
/** Per-tick advance: 8 minutes of solar time (day) or 2 days (year). */
const DAY_STEP_MIN = 8;
const YEAR_STEP_DAYS = 2;

export function SolarPanel() {
  const cesiumAvailable = useViewerStore((s) => s.cesiumAvailable);

  const enabled = useViewerStore((s) => s.solarEnabled);
  const setEnabled = useViewerStore((s) => s.setSolarEnabled);
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

  const setCesiumEnabled = useViewerStore((s) => s.setCesiumEnabled);
  const dataSource = useViewerStore((s) => s.cesiumDataSource);
  const setDataSource = useViewerStore((s) => s.setCesiumDataSource);

  // ── Animation sweep loop ────────────────────────────────────────────────
  // Reads/writes the studied instant imperatively each tick to avoid stale
  // closures, and wraps within the current day (day sweep) or year (year
  // sweep) so the animation loops cleanly.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!enabled || !playing) return;
    intervalRef.current = setInterval(() => {
      const store = useViewerStore.getState();
      const current = store.solarDateMs;
      const d = new Date(current);
      let next: number;
      if (store.solarSweepMode === 'day') {
        const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        const minutes = (current - dayStart) / MS_PER_MIN;
        const nextMinutes = (minutes + DAY_STEP_MIN) % 1440;
        next = dayStart + nextMinutes * MS_PER_MIN;
      } else {
        const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
        const dayOfYear = Math.floor((current - yearStart) / MS_PER_DAY);
        const isLeap = (d.getUTCFullYear() % 4 === 0 && d.getUTCFullYear() % 100 !== 0) || d.getUTCFullYear() % 400 === 0;
        const daysInYear = isLeap ? 366 : 365;
        const timeOfDay = current - (yearStart + dayOfYear * MS_PER_DAY);
        const nextDay = (dayOfYear + YEAR_STEP_DAYS) % daysInYear;
        next = yearStart + nextDay * MS_PER_DAY + timeOfDay;
      }
      store.setSolarDateMs(next);
    }, TICK_MS);
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [enabled, playing, sweepMode]);

  if (!cesiumAvailable) return null;

  const offsetMin = offsetMinutesFor(useLocalTime, sunInfo?.longitude);
  const minutes = minutesOfDay(dateMs, offsetMin);
  const tzLabel = useLocalTime
    ? `Site${sunInfo ? ` (UTC${offsetMin >= 0 ? '+' : '−'}${Math.abs(offsetMin / 60).toFixed(1)})` : ''}`
    : 'UTC';

  const toggleStudy = () => {
    const next = !enabled;
    setEnabled(next);
    if (next) setCesiumEnabled(true);
  };

  return (
    <div className="absolute top-4 right-4 z-10 pointer-events-auto w-60 bg-background/90 backdrop-blur-sm rounded-lg border shadow-lg p-2 flex flex-col gap-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Sun Path
        </span>
        <button
          type="button"
          aria-pressed={enabled}
          onClick={toggleStudy}
          className={cn(
            'px-2 py-0.5 rounded text-[10px] font-semibold uppercase transition-colors',
            enabled ? 'bg-teal-600 text-white' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          {enabled ? 'On' : 'Off'}
        </button>
      </div>

      {enabled && (
        <>
          {/* Date + play/pause */}
          <div className="flex items-end gap-1.5">
            <label className="flex flex-col gap-0.5 flex-1">
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
                value={toDateInputValue(dateMs, offsetMin)}
                onChange={(e) => setDateMs(composeMs(e.target.value, minutes, offsetMin))}
                className="w-full bg-muted/40 rounded px-1.5 py-1 border text-foreground"
              />
            </label>
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
              <span className="tabular-nums text-foreground">{formatTime(dateMs, offsetMin)}</span>
            </span>
            <input
              type="range"
              min={0}
              max={1439}
              step={5}
              value={minutes}
              onChange={(e) => setDateMs(composeMs(toDateInputValue(dateMs, offsetMin), Number(e.target.value), offsetMin))}
              className="w-full accent-teal-600"
            />
          </label>

          {/* Sweep mode */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Sweep</span>
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
          </div>

          {/* Toggles */}
          <div className="flex gap-1">
            <ToggleChip label="Dome" active={showSunPath} onClick={() => setShowSunPath(!showSunPath)} />
            <ToggleChip label="Shadows" active={showShadows} onClick={() => setShowShadows(!showShadows)} />
          </div>

          {/* Context source */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Context</span>
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
          </div>

          {/* Readout */}
          <div className="mt-1 pt-2 border-t grid grid-cols-2 gap-x-2 gap-y-0.5 tabular-nums">
            <Readout label="Azimuth" value={sunInfo ? `${sunInfo.azimuth.toFixed(1)}°` : '—'} />
            <Readout label="Altitude" value={sunInfo ? `${sunInfo.altitude.toFixed(1)}°` : '—'} />
            <Readout label="Sunrise" value={formatTime(sunInfo?.sunriseMs ?? null, offsetMin)} />
            <Readout label="Sunset" value={formatTime(sunInfo?.sunsetMs ?? null, offsetMin)} />
            <Readout label="Noon" value={formatTime(sunInfo?.solarNoonMs ?? null, offsetMin)} />
            <Readout
              label="Site"
              value={sunInfo ? `${sunInfo.latitude.toFixed(2)}, ${sunInfo.longitude.toFixed(2)}` : '—'}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** Small pill toggle button used for the dome/shadow switches. */
function ToggleChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex-1 px-2 py-1 rounded text-[10px] font-semibold uppercase transition-colors',
        active ? 'bg-teal-600 text-white' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
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
