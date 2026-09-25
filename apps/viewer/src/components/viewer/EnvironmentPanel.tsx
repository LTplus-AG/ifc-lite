/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Environment panel — one place for sky, lighting and the sun-path study,
 * aware of which rendering path is active (#5506: the docked side panel
 * that replaced the floating "Sun & Sky" panel, `SunSkyPanel.tsx`):
 *
 *   • Standalone (WebGPU): lighting preset + exposure shape the model's
 *     shading, Sky draws the procedural sky, and the sun study (when the
 *     model is georeferenced) drives the real sun direction.
 *   • World context (Cesium): the model is composited into Cesium, which
 *     lights the scene from its sun and atmosphere — so preset/exposure
 *     hide and Sky toggles the atmosphere instead. The study adds the
 *     sun-path dome and real cast shadows.
 *
 * Docks in the right pane like every other side panel (`renderPanelBody`,
 * registry id `environment`) — no drag, no floating mount, no self-owned
 * open/collapse state; the sidebar shows or hides the whole panel.
 */

import { Play, Pause, Sun, X } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useViewerStore } from '@/store';
import { useEffectiveSkyEnabled } from '@/hooks/useEffectiveSkyEnabled';
import { cn } from '@/lib/utils';
import type { CesiumDataSource } from '@/store/slices/cesiumSlice';
import { CustomBasemapEditor } from './CustomBasemapEditor';
import { CustomTilesetEditor } from './CustomTilesetEditor';
import type { SolarSweepMode } from '@/store/slices/solarSlice';
import { LIGHTING_PRESETS, LIGHTING_PRESET_ORDER, isLightingPresetId } from '@/lib/lighting-presets';
import { LightingTrimControls } from './LightingTrimControls';
import { ShadowControls } from './ShadowControls';
import { SunTimeControls } from './SunTimeControls';
import { posthog } from '@/lib/analytics';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import {
  solarDisplayOffsetMinutes,
  toSolarDateInputValue,
  solarMinutesOfDay,
  composeSolarMs,
  formatSolarTime,
} from '@/lib/solar-time';

/** `labelKey`/`hintKey` data table (`sectionConstants.ts`'s `AXIS_INFO` pattern). */
const CONTEXT_SOURCES: Array<{ value: CesiumDataSource; labelKey: TranslationKey; hintKey: TranslationKey }> = [
  { value: 'osm-map', labelKey: 'viewportLighting.sunSkyPanel.cesium.contextSources.osmMap.label', hintKey: 'viewportLighting.sunSkyPanel.cesium.contextSources.osmMap.hint' },
  { value: 'osm-buildings', labelKey: 'viewportLighting.sunSkyPanel.cesium.contextSources.osmBuildings.label', hintKey: 'viewportLighting.sunSkyPanel.cesium.contextSources.osmBuildings.hint' },
  { value: 'google-photorealistic', labelKey: 'viewportLighting.sunSkyPanel.cesium.contextSources.photorealistic.label', hintKey: 'viewportLighting.sunSkyPanel.cesium.contextSources.photorealistic.hint' },
  { value: 'custom', labelKey: 'viewportLighting.sunSkyPanel.cesium.contextSources.custom.label', hintKey: 'viewportLighting.sunSkyPanel.cesium.contextSources.custom.hint' },
  { value: 'custom-3dtiles', labelKey: 'viewportLighting.sunSkyPanel.cesium.contextSources.custom3dTiles.label', hintKey: 'viewportLighting.sunSkyPanel.cesium.contextSources.custom3dTiles.hint' },
];

const SWEEP_MODES: Array<{ value: SolarSweepMode; labelKey: TranslationKey; hintKey: TranslationKey }> = [
  { value: 'day', labelKey: 'viewportLighting.sunSkyPanel.sunStudy.sweepModes.day.label', hintKey: 'viewportLighting.sunSkyPanel.sunStudy.sweepModes.day.hint' },
  { value: 'year', labelKey: 'viewportLighting.sunSkyPanel.sunStudy.sweepModes.year.label', hintKey: 'viewportLighting.sunSkyPanel.sunStudy.sweepModes.year.hint' },
];

interface EnvironmentPanelProps {
  onClose?: () => void;
}

export function EnvironmentPanel({ onClose }: EnvironmentPanelProps) {
  const setSkyEnabled = useViewerStore((s) => s.setEnvSkyEnabled);
  const preset = useViewerStore((s) => s.envPreset);
  const setPreset = useViewerStore((s) => s.setEnvPreset);

  const cesiumAvailable = useViewerStore((s) => s.cesiumAvailable);
  const cesiumEnabled = useViewerStore((s) => s.cesiumEnabled);
  // Cesium-context "on by default until the user says otherwise" (#4771):
  // the toggle below only renders in that context, so this is always the
  // effective on-screen state, not the raw persisted flag.
  const skyEnabled = useEffectiveSkyEnabled();
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

  const { t } = useTranslation();

  const offsetMin = solarDisplayOffsetMinutes(useLocalTime, sunInfo?.longitude);
  const minutes = solarMinutesOfDay(dateMs, offsetMin);
  // `{offset}` is a formatted `UTC±H.h` string built here, not translated text.
  const utcOffset = `UTC${offsetMin >= 0 ? '+' : '−'}${Math.abs(offsetMin / 60).toFixed(1)}`;
  const tzLabel = !useLocalTime
    ? t('viewportLighting.sunSkyPanel.sunStudy.timezone.utc')
    : sunInfo
      ? t('viewportLighting.sunSkyPanel.sunStudy.timezone.siteWithOffset', { offset: utcOffset })
      : t('viewportLighting.sunSkyPanel.sunStudy.timezone.site');

  return (
    <div className="flex h-full flex-col">
      {/* House header — icon, title, close, the same shape as every other
          docked side panel (Location zones, Load report, Cost). */}
      <div className="flex items-center gap-2 border-b p-3">
        <Sun className="h-4 w-4 text-amber-600" />
        <span className="flex-1 text-sm font-medium">{t('viewportLighting.sunSkyPanel.header.title')}</span>
        {onClose && (
          <IconButton label={t('viewportLighting.sunSkyPanel.header.closeTitle')} className="h-6 w-6" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2 text-xs">
        {/* Environment — the preset IS the whole look: every preset except
            Default brings its own sky. In the world context the model is
            lit by Cesium's sun instead, so the choice becomes a single
            Sky switch (on by default there, #4771 — a persisted choice
            still wins). */}
        {cesiumEnabled ? (
          <>
            <div className="flex items-center gap-1">
              <ToggleChip
                label={t('viewportLighting.sunSkyPanel.cesium.skyToggleLabel')}
                active={skyEnabled}
                onClick={() => setSkyEnabled(!skyEnabled)}
                title={t('viewportLighting.sunSkyPanel.cesium.skyToggleTitle')}
              />
              <span className="flex-1 px-1 text-[9px] leading-tight text-muted-foreground">
                {t('viewportLighting.sunSkyPanel.cesium.lightingHint')}
              </span>
            </div>
            {/* Base map — pick the real-world backdrop. Photorealistic can
                be overwhelming; the plain OSM map is a simple flat
                alternative (#1744). Lives here (not just in the sun study)
                so the choice is available whenever the world context is on. */}
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{t('viewportLighting.sunSkyPanel.cesium.baseMapLabel')}</span>
              <select
                aria-label={t('viewportLighting.sunSkyPanel.cesium.baseMapAria')}
                value={dataSource}
                onChange={(e) => setDataSource(e.target.value as CesiumDataSource)}
                title={t(CONTEXT_SOURCES.find((s) => s.value === dataSource)?.hintKey ?? 'viewportLighting.sunSkyPanel.cesium.contextSources.osmMap.hint')}
                className="w-full bg-muted/40 rounded px-1.5 py-1 border text-foreground text-[10px]"
              >
                {CONTEXT_SOURCES.map((src) => (
                  <option key={src.value} value={src.value}>{t(src.labelKey)}</option>
                ))}
              </select>
            </label>
            {dataSource === 'custom' && <CustomBasemapEditor />}
            {dataSource === 'custom-3dtiles' && <CustomTilesetEditor />}
          </>
        ) : (
          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{t('viewportLighting.sunSkyPanel.standalone.environmentLabel')}</span>
            <select
              aria-label={t('viewportLighting.sunSkyPanel.standalone.environmentAria')}
              value={preset}
              onChange={(e) => { if (isLightingPresetId(e.target.value)) setPreset(e.target.value); }}
              title={LIGHTING_PRESETS[preset].hint}
              className="w-full bg-muted/40 rounded px-1.5 py-1 border text-foreground text-[10px]"
            >
              {LIGHTING_PRESET_ORDER.map((id) => (
                <option key={id} value={id}>
                  {LIGHTING_PRESETS[id].label}{id === 'default' ? t('viewportLighting.sunSkyPanel.standalone.noSkySuffix') : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* WebGPU shading trims (exposure + light hardness + terminator
            softness) — hidden in world-context mode, where Cesium lights. */}
        {!cesiumEnabled && <LightingTrimControls />}

        {/* Sun cast shadows (#2670) — standalone WebGPU only; Cesium casts
            its own in world-context. */}
        {!cesiumEnabled && <ShadowControls />}

        {/* Manual time-of-day sun (#2670) for models without georeference —
            the real study (below, when georeferenced) overrides it. */}
        {!cesiumEnabled && <SunTimeControls />}

        {/* Sun study — needs a georeferenced model for the real sun */}
        {cesiumAvailable && (
          <>
            <div className="flex items-center justify-between gap-2 pt-2 border-t">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t('viewportLighting.sunSkyPanel.sunStudy.title')}</span>
              <button
                type="button"
                aria-pressed={solarEnabled}
                onClick={() => {
                  const next = !solarEnabled;
                  setSolarEnabled(next);
                  // Fire only on enable — the sun study is a live analysis,
                  // so "turned on" is the run signal (no discrete compute step).
                  if (next) {
                    posthog.capture('solar_analysis_run', {
                      sweep_mode: sweepMode,
                      use_local_time: useLocalTime,
                      data_source: dataSource,
                    });
                  }
                }}
                className={cn(
                  'px-2 py-0.5 rounded text-[10px] font-semibold uppercase transition-colors',
                  solarEnabled ? 'bg-amber-500 text-zinc-950' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {solarEnabled ? t('viewportLighting.sunSkyPanel.sunStudy.on') : t('viewportLighting.sunSkyPanel.sunStudy.off')}
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
                      <span>{t('viewportLighting.sunSkyPanel.sunStudy.dateLabel')}</span>
                      <button
                        type="button"
                        onClick={() => setUseLocalTime(!useLocalTime)}
                        title={t('viewportLighting.sunSkyPanel.sunStudy.timezoneToggleTitle')}
                        className="hover:text-foreground transition-colors"
                      >
                        {tzLabel}
                      </button>
                    </span>
                    <input
                      type="date"
                      aria-label={t('viewportLighting.sunSkyPanel.sunStudy.dateAria')}
                      value={toSolarDateInputValue(dateMs, offsetMin)}
                      onChange={(e) => setDateMs(composeSolarMs(e.target.value, minutes, offsetMin))}
                      className="w-full bg-muted/40 rounded px-1.5 py-1 border text-foreground"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={togglePlaying}
                    aria-label={playing ? t('viewportLighting.sunSkyPanel.sunStudy.pauseAria') : t('viewportLighting.sunSkyPanel.sunStudy.playAria')}
                    aria-pressed={playing}
                    className={cn(
                      'h-[26px] w-[26px] flex items-center justify-center rounded transition-colors shrink-0',
                      playing ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  </button>
                </div>

                {/* Time of day */}
                <label className="flex flex-col gap-0.5">
                  <span className="flex justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
                    <span>{t('viewportLighting.sunSkyPanel.sunStudy.timeLabel')}</span>
                    <span className="tabular-nums text-foreground">{formatSolarTime(dateMs, offsetMin)}</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1439}
                    step={5}
                    value={minutes}
                    onChange={(e) => setDateMs(composeSolarMs(toSolarDateInputValue(dateMs, offsetMin), Number(e.target.value), offsetMin))}
                    className="w-full accent-primary"
                  />
                </label>

                {/* Sweep mode */}
                <div className="flex gap-1">
                  {SWEEP_MODES.map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      title={t(m.hintKey)}
                      aria-pressed={sweepMode === m.value}
                      onClick={() => setSweepMode(m.value)}
                      className={cn(
                        'flex-1 px-1.5 py-1 rounded text-[10px] transition-colors',
                        sweepMode === m.value
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      {t(m.labelKey)}
                    </button>
                  ))}
                </div>

                {/* World-context extras: dome + shadows. The base-map
                    picker lives above (visible whenever the world context is
                    on), so the sun study only adds its dome/shadow toggles. */}
                {cesiumEnabled ? (
                  <div className="flex gap-1">
                    <ToggleChip className="flex-1" label={t('viewportLighting.sunSkyPanel.sunStudy.domeToggle')} active={showSunPath} onClick={() => setShowSunPath(!showSunPath)} />
                    <ToggleChip className="flex-1" label={t('viewportLighting.sunSkyPanel.sunStudy.shadowsToggle')} active={showShadows} onClick={() => setShowShadows(!showShadows)} />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setCesiumEnabled(true)}
                    className="text-left text-[9px] leading-snug text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {t('viewportLighting.sunSkyPanel.sunStudy.enableWorldContextHint')}
                  </button>
                )}

                {!sunInfo && (
                  <p className="text-[9px] leading-snug text-amber-600 dark:text-amber-500">
                    {t('viewportLighting.sunSkyPanel.sunStudy.noSiteWarning')}
                  </p>
                )}

                {/* Readout */}
                <div className="mt-1 pt-2 border-t grid grid-cols-2 gap-x-2 gap-y-0.5 tabular-nums">
                  <Readout label={t('viewportLighting.sunSkyPanel.sunStudy.readout.azimuth')} value={sunInfo ? `${sunInfo.azimuth.toFixed(1)}°` : '—'} />
                  <Readout label={t('viewportLighting.sunSkyPanel.sunStudy.readout.altitude')} value={sunInfo ? `${sunInfo.altitude.toFixed(1)}°` : '—'} />
                  <Readout label={t('viewportLighting.sunSkyPanel.sunStudy.readout.sunrise')} value={formatSolarTime(sunInfo?.sunriseMs ?? null, offsetMin)} />
                  <Readout label={t('viewportLighting.sunSkyPanel.sunStudy.readout.sunset')} value={formatSolarTime(sunInfo?.sunsetMs ?? null, offsetMin)} />
                  <Readout label={t('viewportLighting.sunSkyPanel.sunStudy.readout.noon')} value={formatSolarTime(sunInfo?.solarNoonMs ?? null, offsetMin)} />
                  <Readout
                    label={t('viewportLighting.sunSkyPanel.sunStudy.readout.site')}
                    value={sunInfo ? `${sunInfo.latitude.toFixed(2)}, ${sunInfo.longitude.toFixed(2)}` : '—'}
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>
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
        active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
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
