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
 * Gated exactly like the right-click menu's Duplicate, through the one
 * shared `entityMutationAccess` predicate (Edit mode, collab role,
 * editable model, live mutation view — #6233).
 */

import { useEffect } from 'react';
import { useViewerStore, resolveEntityRef } from '@/store';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { registerKeyboardCommand } from '@/lib/commands/dispatcher';
import { ensureEntityMutationView, entityMutationAccess } from './useContextMutationAccess';

export function useDuplicateShortcut() {
  const duplicateEntity = useViewerStore((s) => s.duplicateEntity);
  const setSelectedEntityId = useViewerStore((s) => s.setSelectedEntityId);
  const { t } = useTranslation();

  useEffect(() => {
    const unregister = registerKeyboardCommand('edit.duplicate', (e) => {
      const selectedId = useViewerStore.getState().selectedEntityId;
      if (selectedId === null) return false;

      const ref = resolveEntityRef(selectedId);
      if (!ref) return false;

      // From here on the shortcut is ours: returning nothing suppresses the
      // browser's bookmark default even when the duplicate is refused.
      // The menu creates the editable view when it opens; a keypress has no
      // such moment, so create it here (a no-op when editing is refused).
      ensureEntityMutationView(ref.modelId);
      const access = entityMutationAccess(useViewerStore.getState(), ref.modelId);
      if (!access.canEdit) {
        if (access.editReasonKey) toast.info(t(access.editReasonKey));
        return;
      }

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
    });
    return unregister;
  }, [duplicateEntity, setSelectedEntityId, t]);
}
