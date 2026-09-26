/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Clear both homes of a sticky query override so the next read stays reset. */
export function clearStickyQueryOverride(storageKey: string, queryParam: string): void {
  try {
    localStorage.removeItem(storageKey);
  } catch (error) {
    console.warn(`[${queryParam}] could not clear saved override`, error);
  }

  if (typeof window === 'undefined') return;
  const href = window.location?.href;
  if (typeof href !== 'string' || typeof window.history?.replaceState !== 'function') return;
  try {
    const url = new URL(href);
    if (!url.searchParams.has(queryParam)) return;
    url.searchParams.delete(queryParam);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  } catch (error) {
    console.warn(`[${queryParam}] could not clear URL override`, error);
  }
}
