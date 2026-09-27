/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which side of the Data validation panel (#5138) is on screen: IDS
 * validation or Information validation. `null` means no pick yet, so the
 * panel falls back to whichever side already has content, else the entry
 * cards.
 *
 * This lives outside React only so the IDS tour can put the panel on its IDS
 * side (#5608): Load IDS File, Run Validation and the results only mount
 * there, and behind the entry cards every IDS step lost its anchor. It is
 * set before the panel mounts when the tour opens the panel itself, so the
 * pick lasts the session rather than one mount; the header toggle stays
 * visible either way, so a remembered pick never hides the other side.
 */

import { create } from 'zustand';

export type ValidationSourceChoice = 'ids' | 'rules';

export const useValidationSourceChoice = create<{ choice: ValidationSourceChoice | null }>()(() => ({
  choice: null,
}));

export function setValidationSourceChoice(choice: ValidationSourceChoice | null): void {
  useValidationSourceChoice.setState({ choice });
}
