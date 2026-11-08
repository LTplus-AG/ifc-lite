/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CSSProperties } from 'react';

/**
 * Everything drawn over the map tiles takes its ink from the basemap that is
 * actually showing, not from the app theme (#8802 R5): "Toggle style" can put
 * light tiles under the dark theme and dark tiles under the light one. The
 * map container carries the ink (`color`) and the opposite ink as
 * `--map-pin-halo`. The origin pin and the footprint paint the ink. The picked
 * pin paints the ink too, with a 2px outline in the opposite ink, so it is told
 * apart from the origin pin by shape and outline, never by a hue that one of
 * the two tile styles would swallow.
 */
export function mapInkClass(darkBasemap: boolean): string {
  return darkBasemap ? 'text-scrim-foreground' : 'text-scrim';
}

export function mapInkStyle(darkBasemap: boolean): CSSProperties {
  return { '--map-pin-halo': darkBasemap ? 'var(--color-scrim)' : 'var(--color-scrim-foreground)' } as CSSProperties;
}

/** The picked-position pin: ink fill, opposite-ink outline (see above). */
export const PICKED_PIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke-width="2" style="stroke: var(--map-pin-halo)"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>';

export function pickedPinElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.innerHTML = PICKED_PIN_SVG;
  el.dataset.mapPin = 'picked';
  el.style.cursor = 'grab';
  return el;
}
