/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { mintRoomId, mintRoomToken, releaseRoomClaim } from '@/lib/collab/share-link';
import { buildShareSeed, prepareShareSeed, type ShareScope } from '@/lib/collab/share-scope';

export function useShareRoomCreation({ open, hasModel, collabRoomId, awaitingConsent, scope, setNotice }: {
  open: boolean; hasModel: boolean; collabRoomId: string | null; awaitingConsent: boolean; scope: ShareScope;
  setNotice: (notice: string | null) => void;
}) {
  const { t } = useTranslation();
  const startCollab = useViewerStore(s => s.startCollab);
  const [creating, setCreating] = useState(false);
  const roomAttemptRef = useRef<{ roomId: string; joining: boolean } | null>(null);
  useEffect(() => {
    setCreating(false);
    return () => {
      const owner = roomAttemptRef.current;
      roomAttemptRef.current = null;
      const state = useViewerStore.getState();
      // A committed room outlives this dialog. A pending seed uses roomId as
      // its ownership check, so leaving retires the join before more uploads.
      if (owner?.joining && state.collabRoomId === owner.roomId && !state.collabSession) state.stopCollab();
    };
  }, [open]);
  // 1. Ensure a room: the creator mints an admin token (first-touch) and joins
  // with it, seeding the model, so it's authorized to mint role-scoped share
  // links thereafter. Deliberately NOT re-run by `collabRoomId` flipping to
  // the new room — the attempt ref carries this promise across re-renders.
  useEffect(() => {
    if (!open) {
      roomAttemptRef.current = null;
      return;
    }
    if (!hasModel || collabRoomId || roomAttemptRef.current || awaitingConsent) return;
    const roomId = mintRoomId();
    setCreating(true);
    setNotice(null);
    const owner = { roomId, joining: false };
    roomAttemptRef.current = owner;
    const isCurrent = () => roomAttemptRef.current === owner;
    void (async () => {
      let adminToken: string | undefined;
      try {
        // Reject known-invalid metadata before claiming a room (#6565).
        const preflight = useViewerStore.getState();
        buildShareSeed(preflight.models, preflight.activeModelId, scope, preflight.georefMutations);
        adminToken = await mintRoomToken({ roomId, role: 'admin' });
        // Models can change during minting. Read fresh and always pass a seed,
        // even empty, so startCollab retains the owner path (#4444).
        if (!isCurrent()) return;
        const st = useViewerStore.getState();
        const seed = await prepareShareSeed(st.models, st.mutationViews, st.activeModelId, scope, st.georefMutations);
        if (!isCurrent()) return;
        owner.joining = true;
        await startCollab({
          roomId,
          role: 'admin',
          token: adminToken,
          seed,
        });
        // `startCollab` resolves without a live room when the session never
        // came up (it logs why) or the user left mid-join (RoomPanel's Leave).
        // Neither is a connection failure this dialog can tell apart, and the
        // attempt ref blocks a retry until it is re-opened — so say exactly
        // that instead of sitting on "Creating room…" forever.
        if (isCurrent() && useViewerStore.getState().collabRoomId !== roomId) {
          setNotice(t('shareDialog.roomCreationFailed'));
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[collab] room creation failed:', err);
        if (isCurrent()) setNotice(t('shareDialog.linkCreationFailed'));
      } finally {
        owner.joining = false;
        // No live room after the mint: hand the claim back (#6581). The server keeps any room someone joined.
        if (adminToken && useViewerStore.getState().collabRoomId !== roomId) void releaseRoomClaim(roomId, adminToken);
        if (isCurrent()) setCreating(false);
      }
    })();
  }, [open, hasModel, collabRoomId, startCollab, awaitingConsent, scope]);

  return creating;
}
