/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Join the room of a `?room=…&t=…` share link (the model hydrates from the
 * room), unless `pageUrlModelAllowed('room')` refuses it for a host's model.
 */

import type { StartCollabOptions } from '@/store/slices/collabSlice';
import { pageUrlModelAllowed } from '@/lib/processed-model';
import { isCollabEnabled } from './config';
import { parseRoleFromToken } from './share-link';

export function joinRoomFromPageUrl(search: string, startCollab: (opts: StartCollabOptions) => unknown): void {
  if (!isCollabEnabled()) return;
  const params = new URLSearchParams(search);
  const roomId = params.get('room');
  if (!roomId || !pageUrlModelAllowed('room')) return;
  const token = params.get('t') ?? undefined;
  const role = (token && parseRoleFromToken(token)) || 'viewer';
  void startCollab({ roomId, role, token });
}
