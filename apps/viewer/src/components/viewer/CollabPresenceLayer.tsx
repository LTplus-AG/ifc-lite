/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Collaboration presence layer (plan §7.4).
 *
 * Shows live peer cursors when a collab session is active:
 *   - `PresenceBroadcaster` publishes this client's cursor (projected onto the
 *     world ground plane) + active tool over Yjs awareness.
 *   - `PeerPresenceLayer` re-projects each peer's world cursor through *this*
 *     viewer's camera every frame, so a peer's cursor sticks to the model point
 *     regardless of your view angle.
 *
 * This replaces the earlier 2D-fallback `mountPresenceInViewer` bridge (which
 * only lined up when peers shared an identical view) with 3D-anchored cursors
 * built on the renderer's camera callbacks — the house DOM-billboard pattern
 * (cf. AnnotationLayer). The collab runtime stays code-split: these components
 * read only plain presence data and call methods on the already-created session.
 */

import { useViewerStore } from '@/store';
import { PeerPresenceLayer } from './presence/PeerPresenceLayer';
import { PresenceBroadcaster } from './presence/PresenceBroadcaster';

export function CollabPresenceLayer() {
  const sessionActive = useViewerStore((s) => s.collabSession !== null);
  if (!sessionActive) return null;
  return (
    <>
      <PresenceBroadcaster />
      <PeerPresenceLayer />
    </>
  );
}
