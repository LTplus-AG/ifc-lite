/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "May the user author on what they are looking at, and if not, why not?"
 *
 * The STORE already refuses the write (`canEditModel`, gated in every
 * mutation action). This is the UI half: a gate that silently does nothing is
 * a gate the user experiences as a broken app, so the affordance has to be
 * disabled AND say which of the two reasons applies — a shared session they
 * may not write in, or a past version nobody may write to.
 *
 * Stated once, here, because the toolbar derives it in two places
 * (`UndoRedoButtons` and the Edit pill) and a third would have made three
 * copies of the same rule.
 */

import { useViewerStore } from '@/store';

export type EditBlockedReason = 'collab-role' | 'historical-version';

export interface ActiveModelEditability {
  readonly canEdit: boolean;
  /** `null` when editing is allowed. */
  readonly blockedBy: EditBlockedReason | null;
}

export function useCanEditActiveModel(): ActiveModelEditability {
  const canCollabEdit = useViewerStore((s) => s.canCollabEdit());
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const historical = useViewerStore((s) => (activeModelId ? s.isHistoricalModel(activeModelId) : false));

  // Collab first: in a shared session the role is the broader answer, and a
  // viewer-role user looking at a past version is stopped by both.
  if (!canCollabEdit) return { canEdit: false, blockedBy: 'collab-role' };
  if (historical) return { canEdit: false, blockedBy: 'historical-version' };
  return { canEdit: true, blockedBy: null };
}
