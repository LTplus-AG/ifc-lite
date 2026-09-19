/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** GPU-only content that cannot be reconstructed after a device loss. */
export type DeviceRecoveryOmission =
  | 'point-clouds'
  | 'reference-images'
  | 'line-overlays'
  | 'symbolic-overlays'
  | 'section-2d-overlay';

/** Stable failure categories returned by {@link Renderer.recoverDevice}. */
export type DeviceRecoveryFailureReason =
  | 'not-lost'
  | 'cpu-geometry-released'
  | 'scene-not-settled'
  | 'unsupported-authored-meshes'
  | 'cold-restore-failed'
  | 'device-init-failed'
  | 'scene-restore-failed'
  | 'renderer-destroyed';

/** Result of rebuilding a lost renderer in place. */
export type DeviceRecoveryResult =
  | { ok: true; omissions: readonly DeviceRecoveryOmission[] }
  | { ok: false; reason: DeviceRecoveryFailureReason; error?: unknown };
