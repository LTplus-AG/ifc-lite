/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Safe-mode entry point.
 *
 * The user reaches safe mode by appending `?safe=1` (or `?safe=true`)
 * to the URL. The desktop Shift-launch wiring referenced in the spec
 * is a follow-up — the Tauri side needs to append the same query
 * parameter to the loaded URL when Shift is held; until that lands,
 * desktop users use the same URL flag from the address bar.
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
