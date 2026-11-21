/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import type { CollabRole } from '@/store/slices/collabSlice';
import type { ShareScope } from '@/lib/collab/share-scope';
import { useCollabShareReview } from '@/lib/collab/share-review';

/**
 * Applies an agent's staged share (collab.prepareRoom) to the Share dialog's controls.
 * A candidate applies only as the dialog opens: one staged while it is already open would
 * overwrite the user's role choice, and the mint effect would create that invite unasked.
 */
export function useShareCandidate(open: boolean, setScope: (scope: ShareScope) => void, setRole: (role: CollabRole) => void): void {
  const shareCandidate = useCollabShareReview(state => state.candidate);
  const wasOpenRef = useRef(false);
  // An unmounted dialog is not open, whatever its last render said.
  useEffect(() => () => { useCollabShareReview.setState({ dialogOpen: false }); }, []);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (useCollabShareReview.getState().dialogOpen !== open) useCollabShareReview.setState({ dialogOpen: open });
    if (!open || !shareCandidate) return;
    if (!justOpened) { useCollabShareReview.setState({ candidate: null }); return; }
    const state = useViewerStore.getState();
    // The agent prepared a scope over specific models: a different active model
    // or model set means the user would be shown a scope nobody inspected.
    if (shareCandidate.mutationVersion !== state.mutationVersion || shareCandidate.geometryVersion !== state.geometryContentVersion || shareCandidate.roomId !== state.collabRoomId
      || (shareCandidate.scope === 'active' && !shareCandidate.roomId && shareCandidate.activeModelId !== state.activeModelId) || shareCandidate.loadedModelIds.join('\n') !== [...state.models.keys()].join('\n')) { useCollabShareReview.setState({ candidate: null }); return; }
    // Apply the agent's choice once; afterwards the dialog's own controls own scope and role.
    setScope(shareCandidate.scope); setRole(shareCandidate.role); useCollabShareReview.setState({ candidate: null });
  }, [open, shareCandidate, setScope, setRole]);
}
