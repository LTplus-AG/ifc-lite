/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createContext, useContext } from 'react';

/**
 * True inside the Section bar's offscreen copy of row 1, which exists only to be
 * measured (`useHudBarTier`). The copy renders the same chips and menus so its
 * width is the real one, but it must not look like a second bar to anything that
 * addresses controls by test id.
 */
export const SectionBarMeasureContext = createContext(false);

/** `id` on the live bar, `undefined` inside the measuring copy. */
export function useLiveTestId(id: string): string | undefined {
  return useContext(SectionBarMeasureContext) ? undefined : id;
}
