/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Global ⌘D / Ctrl+D shortcut for duplicating the selected entity.
 *
 * Lives outside `useKeyboardControls` so the camera-movement loop
 * stays focused on its job; the duplicate flow doesn't need
 * keyState tracking or per-frame work, just a one-shot trigger.
 *
 * Mirrors the right-click menu's gating: only fires when there's a
 * selection and the active model has a live mutation view.
 */

import { useEffect } from 'react';
import { useViewerStore, resolveEntityRef } from '@/store';
import { toast } from '@/components/ui/toast';

export function useDuplicateShortcut() {
  const duplicateEntity = useViewerStore((s) => s.duplicateEntity);
  const getMutationView = useViewerStore((s) => s.getMutationView);
  const setSelectedEntityId = useViewerStore((s) => s.setSelectedEntityId);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== 'd' && e.key !== 'D') return;

      // Ignore when the user is typing somewhere — Ctrl+D in an
      // input usually means "delete word forward" or browser-bookmark.
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable
      ) {
        return;
      }

      const state = useViewerStore.getState();
      const selectedId = state.selectedEntityId;
      if (selectedId === null) return;

      const ref = resolveEntityRef(selectedId);
      if (!ref) return;

      // Suppress the browser's bookmark default for any duplicate
      // shortcut we recognise — even when the model has no editable
      // mutation view, otherwise Ctrl/⌘+D opens the bookmark dialog
      // while we're "silently no-op'ing" below.
      e.preventDefault();
      e.stopPropagation();

      // Match the menu's canEdit gating — silently no-op on
      // native-metadata models.
      const view = getMutationView(ref.modelId);
      if (!view) return;

      // ⌘D + Shift = +Z (up), ⌘D + Alt = +Y (north), default = +X (east).
      // Power users can chain modifiers without leaving the keyboard;
      // the menu's chip row covers everyone else.
      const direction = e.shiftKey ? '+Z' : e.altKey ? '+Y' : '+X';

      const result = duplicateEntity(ref.modelId, ref.expressId, direction);
      if ('error' in result) {
        toast.error(`Couldn't duplicate: ${result.error}`);
      } else {
        setSelectedEntityId(result.globalId);
        toast.success(`Duplicated as #${result.expressId} (${direction}) — undo to remove`);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [duplicateEntity, getMutationView, setSelectedEntityId]);
}
