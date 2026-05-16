/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Safe-mode entry point.
 *
 * The user reaches safe mode by:
 *   - Appending `?safe=1` to the URL on web.
 *   - Holding Shift while launching on desktop (Tauri side wires that
 *     to the same query parameter on the loaded URL).
 *
 * In safe mode the host:
 *   - Skips automatic activation of the currently-active flavor.
 *   - Disables installed extensions for the session — they remain on
 *     disk but do not load.
 *   - Surfaces a banner so the user knows the rest of the UI is
 *     deliberately minimal.
 *
 * Spec: docs/architecture/ai-customization/05-flavors-and-sharing.md §6.4.
 */

/** Returns true if the current page should boot in safe mode. */
export function isSafeMode(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  const v = params.get('safe');
  return v === '1' || v === 'true';
}
