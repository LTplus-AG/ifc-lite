/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WGS84 geodetic, ECEF and local east/north/up conversions for `geo-warp`.
 * Plain double-precision formulae, no Cesium: the warp runs per lattice node
 * and must not pull the Cesium bundle in.
 */

const WGS84_A = 6378137;
const WGS84_E2 = 0.0066943799901413165;
const DEG = Math.PI / 180;

type Vec3Out = Float64Array | number[];

/** WGS84 geodetic (degrees, ellipsoidal metres) to ECEF metres, written to `out`. */
export function geodeticToEcef(latDeg: number, lonDeg: number, h: number, out: Vec3Out): void {
  const la = latDeg * DEG;
  const lo = lonDeg * DEG;
  const sl = Math.sin(la);
  const cl = Math.cos(la);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sl * sl);
  out[0] = (n + h) * cl * Math.cos(lo);
  out[1] = (n + h) * cl * Math.sin(lo);
  out[2] = (n * (1 - WGS84_E2) + h) * sl;
}

/**
 * ECEF to WGS84 geodetic (degrees, ellipsoidal metres). Fixed-point iteration
 * on the latitude, lat = atan2(z + e²·N·sin lat, p), with the height from the
 * pole-safe form p·cos lat + z·sin lat − a·√(1 − e² sin² lat). Near the
 * surface each step gains about three digits; six reach double precision.
 */
export function ecefToGeodetic(x: number, y: number, z: number): { latitude: number; longitude: number; height: number } {
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - WGS84_E2));
  for (let i = 0; i < 6; i++) {
    const s = Math.sin(lat);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
    lat = Math.atan2(z + WGS84_E2 * n * s, p);
  }
  const s = Math.sin(lat);
  const height = p * Math.cos(lat) + z * s - WGS84_A * Math.sqrt(1 - WGS84_E2 * s * s);
  return { latitude: lat / DEG, longitude: Math.atan2(y, x) / DEG, height };
}

/** The local east/north/up frame at a geodetic point: ECEF ↔ ENU, both directions. */
export interface EnuFrame {
  /** ECEF point to ENU metres in this frame. */
  fromEcef(x: number, y: number, z: number, out: Vec3Out): void;
  /** ENU metres in this frame to an ECEF point. */
  toEcef(e: number, n: number, u: number, out: Vec3Out): void;
}

export function enuFrameAt(latDeg: number, lonDeg: number, h: number): EnuFrame {
  const o = [0, 0, 0];
  geodeticToEcef(latDeg, lonDeg, h, o);
  const la = latDeg * DEG;
  const lo = lonDeg * DEG;
  const sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
  return {
    fromEcef(x, y, z, out) {
      const dx = x - o[0], dy = y - o[1], dz = z - o[2];
      out[0] = -so * dx + co * dy;
      out[1] = -sl * co * dx - sl * so * dy + cl * dz;
      out[2] = cl * co * dx + cl * so * dy + sl * dz;
    },
    toEcef(e, n, u, out) {
      out[0] = o[0] - so * e - sl * co * n + cl * co * u;
      out[1] = o[1] + co * e - sl * so * n + cl * so * u;
      out[2] = o[2] + cl * n + sl * u;
    },
  };
}
