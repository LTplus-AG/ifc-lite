/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deep-link collaboration join: a share link is `?room=…&t=…`, and the
 * recipient joins that room. With seed-into-room the model hydrates from the
 * Y.Doc, so no `?model=` is needed. Joining loads the room's model, so the
 * link is refused once a host has asked for its own model, like `?processed=`
 * and `?model=` (`pageUrlModelAllowed`): no join, and the viewer stays on the
 * host's model.
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
