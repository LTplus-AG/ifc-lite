/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';

/** Start a separate panel scenario without erasing drafts on ordinary unmount. */
export function resetValidationPanelFixture(): void {
  useViewerStore.getState().clearValidationRuleSetDraft();
  useViewerStore.setState({ idsValidationReport: null, validationSource: null });
  setValidationSourceChoice(null);
}
