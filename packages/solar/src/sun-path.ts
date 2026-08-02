/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sun-path geometry — the sampled curves that make up a 3D sun-path dome:
 *
 *   • day paths   — the arc the sun traces across a single day
 *   • analemmas   — the figure-of-eight a fixed clock-hour traces over a year
 *   • graticule   — the static altitude rings + azimuth spokes + cardinals
 *
 * Everything is returned as unit direction vectors in a local ENU frame
 * (east, north, up), so a renderer only has to multiply by a dome radius and
 * add the site origin. The frame matches the IFC/Cesium convention used by
 * the viewer's georeferencing bridge (north = grid/true north, up = +Z).
 */

import {
  solarGeometry,
  sunPositionFromGeometry,
  type SunPosition,
} from './solar-position.js';

const DEG = Math.PI / 180;

/** Unit direction in the local east-north-up frame. */
export interface Enu {
  e: number;
  n: number;
  u: number;
}

/** A single sampled sun position with its direction on the dome. */
export interface SunSample extends SunPosition {
  time: Date;
  /** Unit direction on the dome (below-horizon samples have u < 0). */
  dir: Enu;
  aboveHorizon: boolean;
}

/**
 * Convert an azimuth (deg clockwise from north) + altitude (deg above
 * horizon) into a unit ENU direction. This is the bridge between solar
 * angles and 3D dome geometry.
 */
export function azimuthAltitudeToEnu(azimuthDeg: number, altitudeDeg: number): Enu {
  const az = azimuthDeg * DEG;
  const alt = altitudeDeg * DEG;
  const cosAlt = Math.cos(alt);
  return {
    e: Math.sin(az) * cosAlt,
    n: Math.cos(az) * cosAlt,
    u: Math.sin(alt),
  };
}

/** Build a {@link SunSample} (position + dome direction) for one instant. */
function sampleAt(date: Date, lat: number, lon: number, decl: number, eot: number): SunSample {
  const pos = sunPositionFromGeometry(date, lat, lon, decl, eot);
  return {
    ...pos,
    time: date,
    dir: azimuthAltitudeToEnu(pos.azimuth, pos.altitude),
    aboveHorizon: pos.altitude >= 0,
  };
}

export interface DayPathOptions {
  /** Sampling step in minutes (default 10). */
  stepMinutes?: number;
  /** When true (default), drop samples below the horizon. */
  aboveHorizonOnly?: boolean;
}

/**
 * Sample the sun's path across the UTC calendar day containing `date`.
 * Returns an ordered polyline (morning → evening).
 */
export function dayPath(
  date: Date,
  latitude: number,
  longitude: number,
  options: DayPathOptions = {},
): SunSample[] {
  const step = options.stepMinutes ?? 10;
  const aboveOnly = options.aboveHorizonOnly ?? true;
  // Declination/EoT vary negligibly across a day — compute once at noon.
  const noon = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12, 0, 0),
  );
  const { declination, equationOfTime } = solarGeometry(noon);

  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const samples: SunSample[] = [];
  for (let m = 0; m <= 1440; m += step) {
    const s = sampleAt(new Date(dayStart + m * 60_000), latitude, longitude, declination, equationOfTime);
    if (aboveOnly && !s.aboveHorizon) continue;
    samples.push(s);
  }
  return samples;
}

export interface AnalemmaPath {
  /** Solar clock-hour this analemma is sampled at (0–23, UTC-day local solar). */
  hour: number;
  samples: SunSample[];
}

export interface AnalemmaOptions {
  /** Day step across the year (default 5 → ~73 points per analemma). */
  dayStep?: number;
  /** Only include analemmas with at least one above-horizon sample. */
  aboveHorizonOnly?: boolean;
}

/**
 * Build the figure-of-eight analemma for every whole hour across `year`.
 * Each analemma fixes the local time-of-day and walks the calendar, which is
 * what gives the dome its characteristic vertical hour-curves.
 */
export function analemmaPaths(
  year: number,
  latitude: number,
  longitude: number,
  options: AnalemmaOptions = {},
): AnalemmaPath[] {
  const dayStep = options.dayStep ?? 5;
  const aboveOnly = options.aboveHorizonOnly ?? true;
  // Longitude offset so "hour" means local solar-ish time rather than UTC.
  const lonHourOffset = longitude / 15;

  const paths: AnalemmaPath[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const samples: SunSample[] = [];
    const start = Date.UTC(year, 0, 1);
    const daysInYear = isLeap(year) ? 366 : 365;
    for (let day = 0; day < daysInYear; day += dayStep) {
      const dayMs = start + day * 86_400_000;
      const d = new Date(dayMs);
      const { declination, equationOfTime } = solarGeometry(d);
      // Local hour → UTC instant for this day.
      const utcHour = hour - lonHourOffset;
      const instant = new Date(dayMs + utcHour * 3_600_000);
      samples.push(sampleAt(instant, latitude, longitude, declination, equationOfTime));
    }
    if (aboveOnly && !samples.some((s) => s.aboveHorizon)) continue;
    paths.push({ hour, samples });
  }
  return paths;
}

export interface Graticule {
  /** Concentric altitude rings (each a closed loop of ENU directions). */
  altitudeRings: { altitude: number; ring: Enu[] }[];
  /** Azimuth spokes from horizon to zenith (each a meridian arc). */
  azimuthSpokes: { azimuth: number; arc: Enu[] }[];
  /** Cardinal/ordinal direction markers on the horizon. */
  cardinals: { label: string; dir: Enu }[];
}

export interface GraticuleOptions {
  /** Altitude rings every N degrees (default 15 → 15,30,45,60,75). */
  altitudeStep?: number;
  /** Azimuth spokes every N degrees (default 30). */
  azimuthStep?: number;
  /** Angular resolution of generated arcs in degrees (default 5). */
  resolution?: number;
}

/**
 * The static dome graticule: altitude rings, azimuth spokes and the eight
 * compass labels. Independent of date/site — purely the reference grid the
 * sun paths are drawn against.
 */
export function domeGraticule(options: GraticuleOptions = {}): Graticule {
  const altStep = options.altitudeStep ?? 15;
  const azStep = options.azimuthStep ?? 30;
  const res = options.resolution ?? 5;

  const altitudeRings: Graticule['altitudeRings'] = [];
  for (let alt = altStep; alt < 90; alt += altStep) {
    const ring: Enu[] = [];
    for (let az = 0; az <= 360; az += res) ring.push(azimuthAltitudeToEnu(az, alt));
    altitudeRings.push({ altitude: alt, ring });
  }
  // Horizon ring (altitude 0) is always present.
  const horizon: Enu[] = [];
  for (let az = 0; az <= 360; az += res) horizon.push(azimuthAltitudeToEnu(az, 0));
  altitudeRings.unshift({ altitude: 0, ring: horizon });

  const azimuthSpokes: Graticule['azimuthSpokes'] = [];
  for (let az = 0; az < 360; az += azStep) {
    const arc: Enu[] = [];
    for (let alt = 0; alt <= 90; alt += res) arc.push(azimuthAltitudeToEnu(az, alt));
    azimuthSpokes.push({ azimuth: az, arc });
  }

  const cardinals: Graticule['cardinals'] = [
    ['N', 0], ['NE', 45], ['E', 90], ['SE', 135],
    ['S', 180], ['SW', 225], ['W', 270], ['NW', 315],
  ].map(([label, az]) => ({ label: label as string, dir: azimuthAltitudeToEnu(az as number, 0) }));

  return { altitudeRings, azimuthSpokes, cardinals };
}

/** True if `year` is a Gregorian leap year (366 days). */
function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
