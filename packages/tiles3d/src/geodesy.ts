/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WGS84 geodetic <-> ECEF (earth-centred, earth-fixed) conversions.
 *
 * 3D Tiles places geospatial content in ECEF metres on the WGS84 ellipsoid
 * (EPSG:4978); `region` bounding volumes are geodetic radians plus heights
 * above that ellipsoid (EPSG:4979). These helpers let a caller chain a decoded
 * vertex into any projected CRS via a separate CRS package.
 */

/** WGS84 semi-major axis in metres. */
export const WGS84_A = 6378137.0;
/** WGS84 flattening. */
export const WGS84_F = 1 / 298.257223563;
const E2 = WGS84_F * (2 - WGS84_F);
const E4 = E2 * E2;
const A2 = WGS84_A * WGS84_A;
const DEG = Math.PI / 180;

/** Geodetic position on WGS84: longitude/latitude in degrees, ellipsoidal height in metres. */
export interface Geodetic {
  lon: number;
  lat: number;
  height: number;
}

/** Geodetic (degrees, metres above the WGS84 ellipsoid) to ECEF metres. */
export function geodeticToEcef(lon: number, lat: number, height: number): [number, number, number] {
  const phi = lat * DEG;
  const lam = lon * DEG;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const n = WGS84_A / Math.sqrt(1 - E2 * sinPhi * sinPhi);
  return [
    (n + height) * cosPhi * Math.cos(lam),
    (n + height) * cosPhi * Math.sin(lam),
    (n * (1 - E2) + height) * sinPhi,
  ];
}

/**
 * ECEF metres to WGS84 geodetic, closed form (Vermeille 2002, "Direct
 * transformation from geocentric coordinates to geodetic coordinates",
 * J. Geodesy 76:451-454). Exact to floating-point precision for every point
 * outside the ellipsoid's evolute, i.e. anywhere farther than ~43 km from the
 * Earth's centre; closer points throw a RangeError rather than return a wrong
 * answer (no geospatial tile content lives there).
 */
export function ecefToGeodetic(x: number, y: number, z: number): Geodetic {
  const rho2 = x * x + y * y;
  const p = rho2 / A2;
  const q = ((1 - E2) / A2) * z * z;
  const r = (p + q - E4) / 6;
  if (!(r > 0)) {
    throw new RangeError(`ecefToGeodetic: point (${x}, ${y}, ${z}) is inside the ellipsoid evolute (too close to the Earth's centre)`);
  }
  const s = (E4 * p * q) / (4 * r * r * r);
  const t = Math.cbrt(1 + s + Math.sqrt(s * (2 + s)));
  const u = r * (1 + t + 1 / t);
  const v = Math.sqrt(u * u + E4 * q);
  const w = (E2 * (u + v - q)) / (2 * v);
  const k = Math.sqrt(u + v + w * w) - w;
  const rho = Math.sqrt(rho2);
  const d = (k * rho) / (k + E2);
  const dz = Math.sqrt(d * d + z * z);
  const lat = 2 * Math.atan2(z, d + dz);
  const height = ((k + E2 - 1) / k) * dz;
  const lon = rho === 0 ? 0 : Math.atan2(y, x);
  return { lon: lon / DEG, lat: lat / DEG, height };
}

/**
 * Column-major 4x4 matrix mapping local east-north-up metres at a geodetic
 * point to ECEF. Useful to express a tile's ECEF output in a small local frame.
 */
export function enuToEcefMatrix(lon: number, lat: number, height: number): number[] {
  const [ox, oy, oz] = geodeticToEcef(lon, lat, height);
  const sl = Math.sin(lon * DEG);
  const cl = Math.cos(lon * DEG);
  const sp = Math.sin(lat * DEG);
  const cp = Math.cos(lat * DEG);
  return [
    -sl, cl, 0, 0,
    -sp * cl, -sp * sl, cp, 0,
    cp * cl, cp * sl, sp, 0,
    ox, oy, oz, 1,
  ];
}
