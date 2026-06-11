/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/solar — solar position, sunrise/sunset and 3D sun-path geometry.
 *
 * Pure, dependency-free math: given a site latitude/longitude and an instant,
 * compute where the sun is, and generate the sampled curves for a 3D
 * sun-path dome (day paths, hourly analemmas, graticule). Renderer-agnostic —
 * outputs are plain angles and ENU unit vectors.
 */

export {
  sunPosition,
  sunPositionFromGeometry,
  solarGeometry,
  toJulianDay,
  type SunPosition,
} from './solar-position.js';

export { sunTimes, type SunTimes } from './sun-times.js';

export {
  azimuthAltitudeToEnu,
  dayPath,
  analemmaPaths,
  domeGraticule,
  type Enu,
  type SunSample,
  type DayPathOptions,
  type AnalemmaPath,
  type AnalemmaOptions,
  type Graticule,
  type GraticuleOptions,
} from './sun-path.js';
