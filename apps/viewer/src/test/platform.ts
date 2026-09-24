/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pretend to run on a given `navigator.platform` (`'MacIntel'`, `'Win32'`), so
 * a test can check platform key glyphs (`lib/commands/chord.ts`). Pass `null`
 * to restore happy-dom's own value.
 */
export function setPlatform(platform: string | null): void {
  if (platform === null) {
    Reflect.deleteProperty(navigator, 'platform');
    return;
  }
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
}
