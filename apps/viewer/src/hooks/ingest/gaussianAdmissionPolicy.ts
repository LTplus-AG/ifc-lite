/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Whether a viewer build admits Gaussian captures at all. */
export type GaussianSplatsMode = 'enabled' | 'disabled';

/**
 * The committed default (#8568: general availability, 2026-11-03). Rollback is
 * a reviewed commit that sets this to `'disabled'`, promoted like any other
 * main commit; see `docs/architecture/gaussian-splats-release.md`.
 */
export const GAUSSIAN_SPLATS_DEFAULT: GaussianSplatsMode = 'enabled';

/**
 * The build's mode. `VITE_GAUSSIAN_SPLATS` (declared in the Turbo build
 * environment) overrides the default at build time: `disabled` is the kill
 * switch, `enabled` and the presenter build's `internal-unqualified` admit.
 * Any other non-empty value fails closed, so a mistyped kill switch still
 * disables admission.
 */
export function gaussianSplatsMode(): GaussianSplatsMode {
  const value = import.meta.env?.VITE_GAUSSIAN_SPLATS;
  if (value === undefined || value === '') return GAUSSIAN_SPLATS_DEFAULT;
  return value === 'enabled' || value === 'internal-unqualified' ? 'enabled' : 'disabled';
}

/**
 * The canonical loader's one Gaussian admission decision. Picker, drop, Add
 * model, `?model=`, federation restore and capture reload all reach it through
 * `loadGaussianCapture`, and pickers list `.splat` from it. A disabled build
 * refuses every capture before decoding.
 */
export function gaussianAdmissionEnabled(): boolean {
  return gaussianSplatsMode() === 'enabled';
}

const ROTATE_X_180: readonly number[] = Object.freeze([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]);

/**
 * A presenter-supplied placement for showcase builds (`?gaussianPlacement=rx180`).
 * It is explicit user input for that session, never inferred from a capture's
 * contents, and other builds ignore it. The capture stays uncalibrated.
 */
export function showcaseGaussianPlacement(): readonly number[] | undefined {
  if (!gaussianShowcaseBuild() || typeof window === 'undefined') return undefined;
  return new URLSearchParams(window.location.search).get('gaussianPlacement') === 'rx180' ? ROTATE_X_180 : undefined;
}

/** A presenter/test build (`VITE_GAUSSIAN_SPLATS=internal-unqualified`); never a public deployment. */
export function gaussianShowcaseBuild(): boolean {
  return import.meta.env?.VITE_GAUSSIAN_SPLATS === 'internal-unqualified';
}
