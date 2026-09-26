/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { KeyboardEvent } from 'react';

/** Activate the row editor itself, leaving nested controls to handle their own keys. */
export function activateEditorFromKeyboard(event: KeyboardEvent, startEdit: () => void): void {
  if (event.target !== event.currentTarget) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    startEdit();
  }
}
