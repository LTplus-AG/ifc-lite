/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure 6DoF to camera-delta mapping.
 *
 * Converts a raw SpaceMouse sample into the mouse-equivalent orbit / pan / zoom
 * deltas the existing `Camera` controls already understand, applying a dead
 * zone, per-axis sign, user sensitivity and frame-time integration. No camera
 * or DOM handles here so it is unit-testable in isolation.
 *
 * Axis roles (3Dconnexion object mode):
 *   tx (cap left/right)    -> horizontal pan
 *   tz (cap up/down)       -> vertical pan
 *   ty (cap push/pull)     -> dolly (zoom)
 *   rz (cap twist)         -> orbit azimuth
 *   rx (cap tilt fwd/back) -> orbit elevation
 *   ry (cap roll)          -> ignored (the camera keeps up pinned to world Y)
 */

import {
  AXIS_FULL_SCALE,
  AXIS_SIGN,
  BASE_RATES,
  DEADZONE_FRACTION,
  MAX_FRAME_DELTA_MS,
  STALE_REPORT_TIMEOUT_MS,
} from './constants.js';
import type { SixDof } from './parser.js';

/** Mouse-equivalent camera deltas for a single frame. */
export interface CameraDeltas {
  /** Orbit horizontal delta (azimuth), in mouse pixels. */
  orbitDx: number;
  /** Orbit vertical delta (elevation), in mouse pixels. */
  orbitDy: number;
  /** Pan horizontal delta, in mouse pixels. */
  panDx: number;
  /** Pan vertical delta, in mouse pixels. */
  panDy: number;
  /** Zoom delta, wheel-equivalent (positive = zoom out, like Camera.zoom). */
  zoomDelta: number;
}

const ZERO_DELTAS: CameraDeltas = { orbitDx: 0, orbitDy: 0, panDx: 0, panDy: 0, zoomDelta: 0 };

/**
 * Normalise a raw axis count to [-1, 1] and apply the dead zone. Readings
 * inside the dead zone return 0; outside, the response is rescaled so it ramps
 * from 0 at the dead-zone edge to 1 at full scale (no output discontinuity).
 */
export function applyDeadzone(raw: number, fullScale = AXIS_FULL_SCALE, deadzone = DEADZONE_FRACTION): number {
  if (fullScale <= 0) return 0;
  const n = Math.max(-1, Math.min(1, raw / fullScale));
  const mag = Math.abs(n);
  if (mag <= deadzone) return 0;
  const scaled = (mag - deadzone) / (1 - deadzone);
  return Math.sign(n) * scaled;
}

/**
 * Map a 6DoF sample to per-frame camera deltas.
 *
 * @param state       raw clamped 6DoF sample from the parser
 * @param sensitivity user multiplier (1 = neutral)
 * @param deltaMs     frame time in milliseconds (for frame-rate independence);
 *                    capped at MAX_FRAME_DELTA_MS so a backgrounded tab's
 *                    first frame back cannot teleport the camera
 */
export function mapSixDofToCameraDeltas(state: SixDof, sensitivity: number, deltaMs: number): CameraDeltas {
  if (!(deltaMs > 0) || !(sensitivity > 0)) return { ...ZERO_DELTAS };

  const dt = Math.min(deltaMs, MAX_FRAME_DELTA_MS) / 1000;
  const gain = sensitivity * dt;

  // Normalised, dead-zoned axis responses in [-1, 1].
  const tx = applyDeadzone(state.tx);
  const ty = applyDeadzone(state.ty);
  const tz = applyDeadzone(state.tz);
  const rx = applyDeadzone(state.rx);
  const rz = applyDeadzone(state.rz);
  // ry (roll) is intentionally ignored.

  // `|| 0` normalises a signed-zero (e.g. -1 * 0) back to +0 so downstream
  // strict-equality checks and logs never see -0.
  return {
    orbitDx: (AXIS_SIGN.orbitYaw * rz * BASE_RATES.orbitPxPerSec * gain) || 0,
    orbitDy: (AXIS_SIGN.orbitPitch * rx * BASE_RATES.orbitPxPerSec * gain) || 0,
    panDx: (AXIS_SIGN.panX * tx * BASE_RATES.panPxPerSec * gain) || 0,
    panDy: (AXIS_SIGN.panY * tz * BASE_RATES.panPxPerSec * gain) || 0,
    zoomDelta: (AXIS_SIGN.dolly * ty * BASE_RATES.zoomDeltaPerSec * gain) || 0,
  };
}

/**
 * True when the last input report is too old to keep driving the camera.
 * Pure so the silent-stall watchdog is unit-testable. Non-finite timestamps
 * count as stale (never move the camera on corrupt clocks).
 */
export function isInputStale(lastReportAtMs: number, nowMs: number): boolean {
  if (!Number.isFinite(lastReportAtMs) || !Number.isFinite(nowMs)) return true;
  return nowMs - lastReportAtMs > STALE_REPORT_TIMEOUT_MS;
}

/** True when every delta is zero (device idle / fully dead-zoned). */
export function deltasAreZero(d: CameraDeltas): boolean {
  return d.orbitDx === 0 && d.orbitDy === 0 && d.panDx === 0 && d.panDy === 0 && d.zoomDelta === 0;
}
