/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 3Dconnexion SpaceMouse tuning constants — the ONE place to adjust device
 * behaviour.
 *
 * We cannot test against real hardware in CI, so every value a specific device
 * variant might disagree on (vendor id, report ids, axis full-scale, axis sign
 * / role) lives here. If a SpaceMouse model reports a different layout or an
 * inverted axis, fixing it is a one-line edit in this file — no logic changes.
 *
 * References: 3Dconnexion USB HID reports.
 *   reportId 1 → translation, three int16 LE  (tx, ty, tz)
 *   reportId 2 → rotation,    three int16 LE  (rx, ry, rz)
 *   reportId 3 → buttons,     bitmask
 * Some newer devices coalesce translation + rotation into a single 12-byte
 * reportId-1 frame (tx, ty, tz, rx, ry, rz); the parser handles both layouts.
 */

/** 3Dconnexion USB vendor id. Covers Compact / Pro / Wireless / Enterprise. */
export const SPACEMOUSE_VENDOR_ID = 0x256f;

/** HID report ids. */
export const REPORT_ID_TRANSLATION = 1;
export const REPORT_ID_ROTATION = 2;
export const REPORT_ID_BUTTONS = 3;

/**
 * Full-scale magnitude of one axis. 3Dconnexion axes saturate around ±350; we
 * clamp to this so a spurious out-of-range sample cannot produce a runaway
 * camera jump. Normalisation divides by this to yield roughly [-1, 1].
 */
export const AXIS_FULL_SCALE = 350;

/**
 * Dead zone as a fraction of full scale. The puck never rests at a perfect
 * zero, so small idle readings must be ignored or the camera would drift.
 */
export const DEADZONE_FRACTION = 0.03;

/**
 * Per-axis role + sign. Change a sign here to invert an axis; change the role
 * mapping if a device orients its axes differently. Translation x/y drive pan,
 * translation z drives dolly, rotation yaw/pitch drive orbit, roll is ignored.
 *
 * Signs were chosen so the model tracks the puck the way 3Dconnexion's own
 * "object mode" does (push the cap right → view pans right, etc.). They are
 * best-effort without hardware and trivially flippable.
 */
export const AXIS_SIGN = {
  panX: -1, // translation tx
  panY: 1, //  translation ty
  dolly: 1, //  translation tz (push away → zoom in)
  orbitYaw: 1, // rotation rz (twist)
  orbitPitch: 1, // rotation rx (tilt)
} as const;

/**
 * Base motion rates, expressed as the mouse-equivalent delta produced per
 * second at full axis deflection and sensitivity 1. The camera controls
 * consume these exactly like a mouse drag / wheel, so they are calibrated in
 * the same units:
 *   - orbit/pan take pixel-like deltas (100px ≈ 1 rad orbit).
 *   - zoom takes a wheel-like delta (≈ deltaY).
 * Frame integration multiplies by (deltaMs / 1000), so motion is frame-rate
 * independent.
 */
export const BASE_RATES = {
  /** Orbit pixels per second at full tilt (≈ 150px ≈ 1.5 rad/s). */
  orbitPxPerSec: 160,
  /** Pan pixels per second at full deflection (pan speed also scales with distance). */
  panPxPerSec: 420,
  /** Wheel-equivalent zoom delta per second at full push. */
  zoomDeltaPerSec: 900,
} as const;

/**
 * Sensitivity slider range. 1 is the neutral default; the value multiplies the
 * base rates above.
 */
export const SENSITIVITY = {
  min: 0.2,
  max: 3,
  step: 0.1,
  default: 1,
} as const;
