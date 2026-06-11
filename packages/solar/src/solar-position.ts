/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Solar position from the NOAA Solar Calculation algorithm.
 *
 * This is the same set of equations used by the NOAA Global Monitoring
 * Laboratory's online calculator (a truncated VSOP/Meeus model). It is
 * accurate to within ~0.01° of azimuth/altitude for years 1900–2100, which
 * is far more than enough for architectural shadow / right-to-light studies.
 *
 * All angles are degrees in the public API. Azimuth is measured clockwise
 * from true north (N=0°, E=90°, S=180°, W=270°) to match compass / IFC
 * grid-north conventions. Altitude is degrees above the horizon (negative
 * when the sun is below the horizon).
 *
 * Time is always a JavaScript `Date` interpreted in UTC (`Date.getTime()`),
 * so the caller never has to reason about the host machine's timezone — pass
 * the absolute instant and the site longitude and the math is exact.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** The Sun's apparent position in the local horizontal (topocentric) frame. */
export interface SunPosition {
  /** Degrees clockwise from true north (0–360). */
  azimuth: number;
  /** Degrees above the horizon (negative below). */
  altitude: number;
  /** Solar declination in degrees (for sun-path construction / debugging). */
  declination: number;
  /** Equation of time in minutes (apparent − mean solar time). */
  equationOfTime: number;
}

/** Julian Day Number for a UTC instant. */
export function toJulianDay(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

/** Julian centuries elapsed since the J2000.0 epoch (2000-01-01 12:00 TT). */
function julianCentury(jd: number): number {
  return (jd - 2_451_545.0) / 36_525;
}

interface SolarGeometry {
  declination: number; // degrees
  equationOfTime: number; // minutes
}

/**
 * Date-only solar geometry (declination + equation of time). These vary
 * slowly over a day, so sun-path samplers can compute them once per day and
 * reuse them across many hour-angle evaluations.
 */
export function solarGeometry(date: Date): SolarGeometry {
  const t = julianCentury(toJulianDay(date));

  const meanLong = mod360(280.46646 + t * (36_000.76983 + t * 0.0003032));
  const meanAnom = 357.52911 + t * (35_999.05029 - 0.0001537 * t);
  const eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  const center =
    Math.sin(meanAnom * DEG) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnom * DEG) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnom * DEG) * 0.000289;

  const trueLong = meanLong + center;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * DEG);

  const meanObliquity =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos((125.04 - 1934.136 * t) * DEG);

  const declination =
    Math.asin(Math.sin(obliquity * DEG) * Math.sin(appLong * DEG)) * RAD;

  const y = Math.tan((obliquity / 2) * DEG) ** 2;
  const equationOfTime =
    4 *
    RAD *
    (y * Math.sin(2 * meanLong * DEG) -
      2 * eccent * Math.sin(meanAnom * DEG) +
      4 * eccent * y * Math.sin(meanAnom * DEG) * Math.cos(2 * meanLong * DEG) -
      0.5 * y * y * Math.sin(4 * meanLong * DEG) -
      1.25 * eccent * eccent * Math.sin(2 * meanAnom * DEG));

  return { declination, equationOfTime };
}

/**
 * Local horizontal position of the Sun at an absolute instant for a site.
 *
 * @param date      Absolute instant (interpreted as UTC via getTime()).
 * @param latitude  Site latitude in degrees (north positive).
 * @param longitude Site longitude in degrees (east positive).
 */
export function sunPosition(date: Date, latitude: number, longitude: number): SunPosition {
  const { declination, equationOfTime } = solarGeometry(date);
  return sunPositionFromGeometry(date, latitude, longitude, declination, equationOfTime);
}

/**
 * Sun position when the (date-only) solar geometry is already known. Lets
 * tight loops over a single day avoid recomputing the slow VSOP terms.
 */
export function sunPositionFromGeometry(
  date: Date,
  latitude: number,
  longitude: number,
  declination: number,
  equationOfTime: number,
): SunPosition {
  // Minutes since UTC midnight of the given instant.
  const utcMinutes =
    date.getUTCHours() * 60 +
    date.getUTCMinutes() +
    date.getUTCSeconds() / 60 +
    date.getUTCMilliseconds() / 60_000;

  // True solar time in minutes (longitude shifts the local meridian; 4 min/°).
  let trueSolarMinutes = utcMinutes + equationOfTime + 4 * longitude;
  trueSolarMinutes = ((trueSolarMinutes % 1440) + 1440) % 1440;

  // Hour angle: 0° at solar noon, negative in the morning, positive afternoon.
  let hourAngle = trueSolarMinutes / 4 - 180;
  if (hourAngle < -180) hourAngle += 360;

  const latRad = latitude * DEG;
  const decRad = declination * DEG;
  const haRad = hourAngle * DEG;

  const cosZenith =
    Math.sin(latRad) * Math.sin(decRad) +
    Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);
  const zenith = Math.acos(clamp(cosZenith, -1, 1));
  const altitude = 90 - zenith * RAD;

  // Azimuth measured clockwise from north, derived from the horizontal ENU
  // components of the solar vector. atan2 keeps the quadrant correct and stays
  // finite at the poles, where the acos form divides by cos(latitude) = 0.
  const east = -Math.cos(decRad) * Math.sin(haRad);
  const north =
    Math.cos(latRad) * Math.sin(decRad) -
    Math.sin(latRad) * Math.cos(decRad) * Math.cos(haRad);
  const azimuth =
    Math.abs(east) < 1e-9 && Math.abs(north) < 1e-9
      ? 0 // Sun directly overhead/underfoot — azimuth is undefined; pick north.
      : mod360(Math.atan2(east, north) * RAD);

  return { azimuth, altitude, declination, equationOfTime };
}

/** Normalise an angle in degrees to the [0, 360) range. */
function mod360(v: number): number {
  return ((v % 360) + 360) % 360;
}

/** Clamp a value to the inclusive [lo, hi] range (guards acos domain errors). */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
