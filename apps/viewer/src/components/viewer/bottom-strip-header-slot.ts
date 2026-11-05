/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A slot in the bottom strip's tab row (#8802 R3b) that the docked panel
 * may portal its own header into, so a panel that has one (the Drawing's
 * cut and actions) does not stack a second title row under the tab that
 * already names it. `null` outside the strip (floating, popped out, a
 * test): the panel then draws its own header row as before.
 */

import { createContext, useContext } from 'react';

export const BottomStripHeaderSlotContext = createContext<HTMLElement | null>(null);

export function useBottomStripHeaderSlot(): HTMLElement | null {
  return useContext(BottomStripHeaderSlotContext);
}
