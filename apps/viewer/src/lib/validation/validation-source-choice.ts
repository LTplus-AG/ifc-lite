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

export const useValidationSourceChoice = create<{ choice: ValidationSourceChoice | null; pendingIdsFile: File | null }>()(() => ({
  choice: null,
  pendingIdsFile: null,
}));

export function setValidationSourceChoice(choice: ValidationSourceChoice | null): void {
  useValidationSourceChoice.setState({ choice });
}

/**
 * The IDS entry card's "Load IDS file" (#8802) opens its file picker inside
 * the click itself (Safari drops a deferred `input.click()`), then hands the
 * picked file here. Loading stays the IDS panel's job: it takes the file once
 * it is on screen and loads it through the same path as its own picker.
 */
export function handIdsFileToPanel(file: File): void {
  useValidationSourceChoice.setState({ choice: 'ids', pendingIdsFile: file });
}

/** Consumes a file from `handIdsFileToPanel`; null when none is waiting. */
export function takePendingIdsFile(): File | null {
  const file = useValidationSourceChoice.getState().pendingIdsFile;
  if (file) useValidationSourceChoice.setState({ pendingIdsFile: null });
  return file;
}
