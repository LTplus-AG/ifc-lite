/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 3Dconnexion SpaceMouse tuning constants, the ONE place to adjust device
 * behaviour.
 *
 * We cannot test against real hardware in CI, so every value a specific device
 * variant might disagree on (vendor id, report ids, axis full-scale, axis sign
 * or role) lives here. If a SpaceMouse model reports a different layout or an
 * inverted axis, fixing it is a one-line edit in this file, no logic changes.
 *
 * References: 3Dconnexion USB HID reports (SpaceMouse Module spec HW-3DX-700048,
 * plus the community drivers webhid-space and nytamin/spacemouse).
 *   reportId 1 -> translation, three int16 LE  (tx, ty, tz)
 *   reportId 2 -> rotation,    three int16 LE  (rx, ry, rz)
 *   reportId 3 -> buttons,     bitmask
 * Some newer devices coalesce translation + rotation into a single 12-byte
 * reportId-1 frame (tx, ty, tz, rx, ry, rz); the parser handles both layouts.
 *
 * Device axis frame (right-handed, cap at rest):
 *   tx+ = cap pushed right, ty+ = cap pulled toward the user,
 *   tz+ = cap pressed down; rx/ry/rz are rotations about those axes.
 */

/**
 * USB vendor ids: 0x046d (Logitech, used by the older SpaceNavigator /
 * SpaceMouse Pro / SpacePilot line) and 0x256f (3Dconnexion's own id, used by
 * Compact / Wireless / Enterprise and everything current).
 */
export const SPACEMOUSE_VENDOR_IDS = [0x046d, 0x256f] as const;

/** HID usage: Generic Desktop page, Multi-axis Controller. */
export const HID_USAGE_PAGE_GENERIC_DESKTOP = 0x01;
export const HID_USAGE_MULTI_AXIS_CONTROLLER = 0x08;

/** HID report ids. */
export const REPORT_ID_TRANSLATION = 1;
export const REPORT_ID_ROTATION = 2;
export const REPORT_ID_BUTTONS = 3;

/**
 * Full-scale magnitude of one axis. 3Dconnexion axes saturate around +/-350; we
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
 * Frames longer than this (background tab, debugger pause) integrate as if
 * they were this long, so the first frame back cannot fold seconds of held
 * deflection into one huge camera jump. Enforced inside the pure mapping so
 * the teleport guard is unit-testable.
 */
export const MAX_FRAME_DELTA_MS = 50;

/**
 * Reports older than this no longer drive the camera. A silent HID stall
 * (driver hiccup, stack freeze, no `disconnect` event) would otherwise latch
 * the last non-zero sample and move the camera forever. Safe because a
 * deflected SpaceMouse streams reports continuously (~125Hz); more than
 * 250ms of silence means released or stalled.
 */
export const STALE_REPORT_TIMEOUT_MS = 250;

/**
 * Per-axis role + sign, following 3Dconnexion's default "object mode": the
 * model follows the puck (push right -> model moves right, twist -> model
 * turns, push away -> move into the scene). Signs are best-effort without
 * hardware and trivially flippable here.
 */
export const AXIS_SIGN = {
  /** tx -> horizontal pan. +1: cap right moves the model right (grab idiom). */
  panX: 1,
  /** tz -> vertical pan. +1: cap pressed down moves the model down. */
  panY: 1,
  /** ty -> dolly. +1: cap pulled back zooms out (camera.zoom positive = out). */
  dolly: 1,
  /** rz (twist) -> orbit azimuth. */
  orbitYaw: 1,
  /** rx (tilt forward/back) -> orbit elevation. */
  orbitPitch: 1,
} as const;

/**
 * Base motion rates, expressed as the mouse-equivalent delta produced per
 * second at full axis deflection and sensitivity 1. The camera controls
 * consume these exactly like a mouse drag / wheel, so they are calibrated in
 * the same units:
 *   - orbit/pan take pixel-like deltas (ORBIT_SENSITIVITY is 0.01 rad/px).
 *   - zoom takes a wheel-like delta (like wheel deltaY).
 * Frame integration multiplies by (deltaMs / 1000), so motion is frame-rate
 * independent.
 */
export const BASE_RATES = {
  /** Orbit pixels per second at full tilt (160px ~= 1.6 rad/s). */
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

/**
 * Device buttons that trigger "fit view" (frame selection, or zoom extents
 * with nothing selected). Buttons 0 and 1 are the two physical buttons on the
 * SpaceNavigator / SpaceMouse Compact / Wireless; larger devices map their
 * first two buttons here too.
 */
export const FIT_BUTTON_INDICES = new Set([0, 1]);
