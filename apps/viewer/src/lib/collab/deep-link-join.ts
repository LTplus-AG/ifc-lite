/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Join the room of a `?room=…&t=…` share link (the model hydrates from the
 * room), unless `pageUrlModelAllowed('room')` refuses it for a host's model.
 */

import type { ViewerState } from '@/store';
import { onHostProcessedModelRequest, pageUrlModelAllowed } from '@/lib/processed-model';
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
  const previous = liveCollabAttempt();
  void collab().startCollab({ roomId, role, token });
  // startCollab installs its attempt before its first await. Keep the guard
  // for that room's lifetime and run it before the host model can start.
  const attempt = liveCollabAttempt();
  if (!attempt?.live || attempt === previous || attempt.roomId !== roomId) return;
  attempt.onRetire(onHostProcessedModelRequest(() => {
    if (attempt.live && liveCollabAttempt() === attempt && !pageUrlModelAllowed('room')) collab().stopCollab();
  }));
}
