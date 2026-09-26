/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, type KeyboardEvent, type RefCallback } from 'react';

/** Activate the row editor itself, leaving nested controls to handle their own keys. */
export function activateEditorFromKeyboard(event: KeyboardEvent, startEdit: () => void): void {
  if (event.target !== event.currentTarget) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    startEdit();
  }
}

/** Return focus to the same trigger after its editor input unmounts. */
export function useReturnFocusAfterEdit(editing: boolean): RefCallback<HTMLElement> {
  const target = useRef<HTMLElement | null>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) wasEditing.current = true;
    else if (wasEditing.current) {
      wasEditing.current = false;
      target.current?.focus();
    }
  }, [editing]);
  return useCallback((node: HTMLElement | null) => { target.current = node; }, []);
}
