/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which side of the Data validation panel (#5138) is on screen: IDS
 * validation, Information validation, or Manual validation (#6401). `null` means no pick yet, so the
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

export type ValidationSourceChoice = 'ids' | 'rules' | 'manual';

export const useValidationSourceChoice = create<{ choice: ValidationSourceChoice | null; idsPickRequested: boolean }>()(() => ({
  choice: null,
  idsPickRequested: false,
}));

export function setValidationSourceChoice(choice: ValidationSourceChoice | null): void {
  useValidationSourceChoice.setState({ choice });
}

/**
 * The IDS entry card's "Load IDS file" (#8802): switch to the IDS side and
 * ask its panel to open the file picker once it mounts. The picker belongs
 * to the IDS panel, which owns loading; the card only starts it.
 */
export function requestIdsFilePick(): void {
  useValidationSourceChoice.setState({ choice: 'ids', idsPickRequested: true });
}

/** Consumes a pending `requestIdsFilePick`; true when one was waiting. */
export function takeIdsFilePickRequest(): boolean {
  if (!useValidationSourceChoice.getState().idsPickRequested) return false;
  useValidationSourceChoice.setState({ idsPickRequested: false });
  return true;
}
