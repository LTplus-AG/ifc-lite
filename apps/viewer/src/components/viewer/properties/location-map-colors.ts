/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Theme colours for what maplibre paints as literals: the origin pin, the
 * picked-position pin and the model footprint (#8802 R5). The site is plain
 * ink and the picked position wears the active ink, so the map carries no
 * decorative hue. Read when the pin or layer is made; without a document
 * (unit tests) the paint falls back to `currentColor`.
 */
export function mapMarkerColor(token: '--color-foreground' | '--color-active'): string {
  if (typeof document === 'undefined') return 'currentColor';
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || 'currentColor';
}
