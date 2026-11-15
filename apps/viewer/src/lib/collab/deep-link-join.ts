/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Join the room of a `?room=…&t=…` share link (the model hydrates from the
 * room), unless `pageUrlModelAllowed('room')` refuses it for a host's model.
 */

import type { StartCollabOptions } from '@/store/slices/collabSlice';
import { onProcessedModelRequest, pageUrlModelAllowed } from '@/lib/processed-model';
import { isCollabEnabled } from './config';
import { parseRoleFromToken } from './share-link';

export function joinRoomFromPageUrl(search: string, startCollab: (opts: StartCollabOptions) => unknown, stopCollab: () => void): void {
  if (!isCollabEnabled()) return;
  const params = new URLSearchParams(search);
  const roomId = params.get('room');
  if (!roomId || !pageUrlModelAllowed('room')) return;
  const token = params.get('t') ?? undefined;
  const role = (token && parseRoleFromToken(token)) || 'viewer';
  // Retire a pending page-link join before it can hydrate or seed the host's model.
  // stopCollab also cancels a session still being created or waiting for sync.
  const unsubscribe = onProcessedModelRequest(() => {
    if (!pageUrlModelAllowed('room')) stopCollab();
  });
  try {
    void Promise.resolve(startCollab({ roomId, role, token })).finally(unsubscribe);
  } catch (error) {
    unsubscribe();
    throw error;
  }
}
