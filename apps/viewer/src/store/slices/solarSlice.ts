/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Solar study state slice — drives the georeferenced 3D sun-path dome and
 * shadow study rendered in the Cesium context overlay.
 *
 * The slice itself only owns *intent* (which instant to study, what to show).
 * The heavy lifting — computing the sun direction, enabling Cesium's sun /
 * shadows, and building the dome geometry — happens in CesiumOverlay, which
 * reads this state and writes the resolved {@link SolarSunInfo} back here for
 * the readout panel.
 *
 * Solar study requires Cesium (it renders the model + OSM context with mutual
 * shadows), so the UI turns Cesium on when the study is enabled.
 */

import type { StateCreator } from 'zustand';

/** Resolved solar readout for the currently studied instant + site. */
export interface SolarSunInfo {
  /** Site latitude in degrees (north positive), from the model georeference. */
  latitude: number;
  /** Site longitude in degrees (east positive). */
  longitude: number;
  /** Sun azimuth in degrees clockwise from true north. */
  azimuth: number;
  /** Sun altitude in degrees above the horizon (negative below). */
  altitude: number;
  /** Sunrise epoch ms, or null (polar night / midnight sun). */
  sunriseMs: number | null;
  /** Sunset epoch ms, or null. */
  sunsetMs: number | null;
  /** Solar-noon epoch ms. */
  solarNoonMs: number;
}

/** Which dimension the animation sweep advances. */
export type SolarSweepMode = 'day' | 'year';

export interface SolarSlice {
  /** Whether the sun-path / shadow study is active. */
  solarEnabled: boolean;
  /** Studied instant as epoch milliseconds (UTC). */
  solarDateMs: number;
  /** Draw the 3D sun-path dome (analemmas, day arc, graticule). */
  solarShowSunPath: boolean;
  /** Render real cast shadows (model ↔ OSM context) via Cesium. */
  solarShowShadows: boolean;
  /** Resolved sun position/times for the readout panel; null until computed. */
  solarSunInfo: SolarSunInfo | null;
  /**
   * Unit vector toward the sun in viewer/world space (Y-up), derived from the
   * studied instant + site georeference. Drives the WebGPU renderer's sun
   * (lighting + procedural sky) so daylight reads identically with and
   * without the Cesium context. Null when the study is off or the site is
   * unknown.
   */
  solarSunDirection: [number, number, number] | null;
  /**
   * Display times in local solar time derived from the site longitude
   * (15°/hour) instead of UTC. This is civil-timezone-agnostic on purpose —
   * sun-path studies care about solar time, and a longitude offset needs no
   * timezone database or DST rules.
   */
  solarUseLocalTime: boolean;
  /** Whether the animation sweep is playing. */
  solarPlaying: boolean;
  /** Which dimension the sweep advances (time-of-day vs day-of-year). */
  solarSweepMode: SolarSweepMode;

  setSolarEnabled: (enabled: boolean) => void;
  toggleSolar: () => void;
  setSolarDateMs: (ms: number) => void;
  setSolarShowSunPath: (show: boolean) => void;
  setSolarShowShadows: (show: boolean) => void;
  setSolarSunInfo: (info: SolarSunInfo | null) => void;
  setSolarSunDirection: (dir: [number, number, number] | null) => void;
  setSolarUseLocalTime: (use: boolean) => void;
  setSolarPlaying: (playing: boolean) => void;
  toggleSolarPlaying: () => void;
  setSolarSweepMode: (mode: SolarSweepMode) => void;
}

/** Default studied instant: a bright equinox midday so the dome reads well. */
function defaultSolarDateMs(): number {
  return Date.UTC(new Date().getUTCFullYear(), 2, 20, 12, 0, 0);
}

export const createSolarSlice: StateCreator<SolarSlice, [], [], SolarSlice> = (set) => ({
  solarEnabled: false,
  solarDateMs: defaultSolarDateMs(),
  solarShowSunPath: true,
  solarShowShadows: true,
  solarSunInfo: null,
  solarSunDirection: null,
  // Default to the site's local solar time (derived from longitude): for a
  // sun-path study "9am" should mean 9am at the site, not UTC.
  solarUseLocalTime: true,
  solarPlaying: false,
  solarSweepMode: 'day',

  setSolarEnabled: (enabled) =>
    set(enabled
      ? { solarEnabled: true }
      : { solarEnabled: false, solarSunInfo: null, solarSunDirection: null, solarPlaying: false }),
  toggleSolar: () =>
    set((s) => (s.solarEnabled
      ? { solarEnabled: false, solarSunInfo: null, solarSunDirection: null, solarPlaying: false }
      : { solarEnabled: true })),
  setSolarDateMs: (ms) => set({ solarDateMs: ms }),
  setSolarShowSunPath: (show) => set({ solarShowSunPath: show }),
  setSolarShowShadows: (show) => set({ solarShowShadows: show }),
  setSolarSunInfo: (info) => set({ solarSunInfo: info }),
  setSolarSunDirection: (dir) => set({ solarSunDirection: dir }),
  setSolarUseLocalTime: (use) => set({ solarUseLocalTime: use }),
  setSolarPlaying: (playing) => set({ solarPlaying: playing }),
  toggleSolarPlaying: () => set((s) => ({ solarPlaying: !s.solarPlaying })),
  setSolarSweepMode: (mode) => set({ solarSweepMode: mode }),
});
