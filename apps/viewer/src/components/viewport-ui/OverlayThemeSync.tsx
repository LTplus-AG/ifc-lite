/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useOverlayThemeSync } from '@/lib/viewport-ui/useOverlayThemeSync';

/** Renders nothing; keeps the overlay palette on `<html>` in step with the theme (#5483). */
export function OverlayThemeSync(): null {
  useOverlayThemeSync();
  return null;
}
