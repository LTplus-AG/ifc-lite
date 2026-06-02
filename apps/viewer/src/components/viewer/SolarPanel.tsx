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
 * Times are handled in UTC throughout so the studied instant is unambiguous
 * regardless of the host machine's timezone; the panel labels them as UTC.
 */

import { useViewerStore } from '@/store';
import { cn } from '@/lib/utils';
import type { CesiumDataSource } from '@/store/slices/cesiumSlice';

/** Epoch ms → "YYYY-MM-DD" for the UTC day (for <input type="date">). */
function toDateInputValue(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

/** Minutes since UTC midnight of the day containing `ms`. */
function minutesOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Compose a new epoch ms from a date string + minutes-of-day. */
function composeMs(dateStr: string, minutes: number): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, (m ?? 1) - 1, d ?? 1, Math.floor(minutes / 60), minutes % 60, 0);
}

/** Epoch ms → "HH:MM" UTC. */
function formatTime(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

const CONTEXT_SOURCES: Array<{ value: CesiumDataSource; label: string; hint: string }> = [
  { value: 'osm-buildings', label: 'OSM Buildings', hint: 'Grey extruded footprints — classic massing context' },
  { value: 'google-photorealistic', label: 'Photorealistic', hint: 'Google 3D Tiles — textured real-world context' },
];

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

  const setCesiumEnabled = useViewerStore((s) => s.setCesiumEnabled);
  const dataSource = useViewerStore((s) => s.cesiumDataSource);
  const setDataSource = useViewerStore((s) => s.setCesiumDataSource);

  if (!cesiumAvailable) return null;

  const minutes = minutesOfDay(dateMs);

  const toggleStudy = () => {
    const next = !enabled;
    setEnabled(next);
    // The study renders in Cesium, so turning it on implies the context is on.
    if (next) setCesiumEnabled(true);
  };

  return (
    <div className="absolute top-2 right-2 z-20 w-64 rounded-md bg-white/90 dark:bg-[#1a1b26]/90 backdrop-blur-sm border border-zinc-200 dark:border-[#292e42] shadow-lg p-3 text-xs font-mono text-zinc-700 dark:text-[#a9b1d6]">
      <div className="flex items-center justify-between mb-2">
        <span className="font-black uppercase tracking-wide text-zinc-900 dark:text-white">Sun Path</span>
        <button
          type="button"
          onClick={toggleStudy}
          className={cn(
            'px-2 py-0.5 rounded text-[10px] font-bold uppercase border transition-colors',
            enabled
              ? 'bg-[#9ece6a] text-black border-[#9ece6a]'
              : 'bg-transparent border-zinc-300 dark:border-[#414868] hover:border-[#9ece6a]',
          )}
        >
          {enabled ? 'On' : 'Off'}
        </button>
      </div>

      {enabled && (
        <>
          {/* Date */}
          <label className="block mb-2">
            <span className="text-[10px] uppercase text-zinc-500 dark:text-[#565f89]">Date (UTC)</span>
            <input
              type="date"
              value={toDateInputValue(dateMs)}
              onChange={(e) => setDateMs(composeMs(e.target.value, minutes))}
              className="mt-0.5 w-full bg-zinc-100 dark:bg-[#24283b] rounded px-1.5 py-1 border border-zinc-200 dark:border-[#414868]"
            />
          </label>

          {/* Time of day */}
          <label className="block mb-2">
            <span className="flex justify-between text-[10px] uppercase text-zinc-500 dark:text-[#565f89]">
              <span>Time (UTC)</span>
              <span className="tabular-nums">{formatTime(dateMs)}</span>
            </span>
            <input
              type="range"
              min={0}
              max={1439}
              step={5}
              value={minutes}
              onChange={(e) => setDateMs(composeMs(toDateInputValue(dateMs), Number(e.target.value)))}
              className="mt-1 w-full accent-[#9ece6a]"
            />
          </label>

          {/* Toggles */}
          <div className="flex gap-2 mb-2">
            <ToggleChip label="Dome" active={showSunPath} onClick={() => setShowSunPath(!showSunPath)} />
            <ToggleChip label="Shadows" active={showShadows} onClick={() => setShowShadows(!showShadows)} />
          </div>

          {/* Context source */}
          <div className="mb-2">
            <span className="text-[10px] uppercase text-zinc-500 dark:text-[#565f89]">Context</span>
            <div className="mt-0.5 flex gap-1">
              {CONTEXT_SOURCES.map((src) => (
                <button
                  key={src.value}
                  type="button"
                  title={src.hint}
                  onClick={() => setDataSource(src.value)}
                  className={cn(
                    'flex-1 px-1.5 py-1 rounded text-[10px] border transition-colors',
                    dataSource === src.value
                      ? 'bg-[#7aa2f7] text-black border-[#7aa2f7]'
                      : 'bg-transparent border-zinc-300 dark:border-[#414868] hover:border-[#7aa2f7]',
                  )}
                >
                  {src.label}
                </button>
              ))}
            </div>
          </div>

          {/* Readout */}
          <div className="mt-2 pt-2 border-t border-zinc-200 dark:border-[#292e42] grid grid-cols-2 gap-x-2 gap-y-0.5 tabular-nums">
            <Readout label="Azimuth" value={sunInfo ? `${sunInfo.azimuth.toFixed(1)}°` : '—'} />
            <Readout label="Altitude" value={sunInfo ? `${sunInfo.altitude.toFixed(1)}°` : '—'} />
            <Readout label="Sunrise" value={formatTime(sunInfo?.sunriseMs ?? null)} />
            <Readout label="Sunset" value={formatTime(sunInfo?.sunsetMs ?? null)} />
            <Readout label="Noon" value={formatTime(sunInfo?.solarNoonMs ?? null)} />
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

function ToggleChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 px-2 py-1 rounded text-[10px] font-bold uppercase border transition-colors',
        active
          ? 'bg-[#bb9af7] text-black border-[#bb9af7]'
          : 'bg-transparent border-zinc-300 dark:border-[#414868] hover:border-[#bb9af7]',
      )}
    >
      {label}
    </button>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-zinc-500 dark:text-[#565f89]">{label}</span>
      <span className="text-right text-zinc-900 dark:text-white">{value}</span>
    </>
  );
}
