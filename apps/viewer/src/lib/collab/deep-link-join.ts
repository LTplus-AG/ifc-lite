/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Join the room of a `?room=…&t=…` share link (the model hydrates from the
 * room), unless `pageUrlModelAllowed('room')` refuses it for a host's model.
 */

import type { ViewerState } from '@/store';
import { onProcessedModelRequest, pageUrlModelAllowed } from '@/lib/processed-model';
import { isCollabEnabled } from './config';
import { liveCollabAttempt } from './session-attempt';
import { parseRoleFromToken } from './share-link';

type CollabControls = Pick<ViewerState, 'startCollab' | 'stopCollab'>;

export function joinRoomFromPageUrl(search: string, collab: () => CollabControls): void {
  if (!isCollabEnabled()) return;
  const params = new URLSearchParams(search);
  const roomId = params.get('room');
  if (!roomId || !pageUrlModelAllowed('room')) return;
  const token = params.get('t') ?? undefined;
  const role = (token && parseRoleFromToken(token)) || 'viewer';
  const joining = collab().startCollab({ roomId, role, token });
  // startCollab begins its attempt before its first await. A host request retires that
  // attempt, and only that one, while it is still joining: stopCollab also cancels a
  // session being created or waiting for sync. A room the user left for, or left and
  // rejoined, is a newer attempt and stays.
  const attempt = liveCollabAttempt();
  const unsubscribe = onProcessedModelRequest(() => {
    if (attempt?.live && liveCollabAttempt() === attempt && !pageUrlModelAllowed('room')) collab().stopCollab();
  });
  void joining.finally(unsubscribe);
}
