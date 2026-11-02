/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The only Gaussian qualification that exists before #8562 acceptance. */
export type GaussianQualification = 'internal-unqualified';

/**
 * The canonical loader's one Gaussian admission decision (#8568 internal
 * qualification). A load is admitted only when its caller passes the explicit
 * test opt-in, or when the build itself is a test/showcase build
 * (`VITE_GAUSSIAN_SPLATS=internal-unqualified`). Public builds leave the
 * variable unset, so picker, drop, federation and restore all still refuse.
 */
export function resolveGaussianQualification(explicit?: GaussianQualification): GaussianQualification | undefined {
  if (explicit === 'internal-unqualified') return explicit;
  return gaussianShowcaseBuild() ? 'internal-unqualified' : undefined;
}

const ROTATE_X_180: readonly number[] = Object.freeze([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]);

/**
 * A presenter-supplied placement for showcase builds (`?gaussianPlacement=rx180`).
 * It is explicit user input for that session, never inferred from a capture's
 * contents, and public builds ignore it. The capture stays uncalibrated.
 */
export function showcaseGaussianPlacement(): readonly number[] | undefined {
  if (!gaussianShowcaseBuild() || typeof window === 'undefined') return undefined;
  return new URLSearchParams(window.location.search).get('gaussianPlacement') === 'rx180' ? ROTATE_X_180 : undefined;
}

/** A build made for internal test/showcase use; never a public deployment. */
export function gaussianShowcaseBuild(): boolean {
  return import.meta.env.VITE_GAUSSIAN_SPLATS === 'internal-unqualified';
}
