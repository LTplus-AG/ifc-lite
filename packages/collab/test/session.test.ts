/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createCollabSession } from '../src/session.js';
import { createPresence } from '../src/awareness/presence.js';

describe('createCollabSession — presence lifecycle (ownsPresence)', () => {
  // Regression guard for session.ts ~114-115/211: a session must only
  // dispose the Presence it created itself. If it disposed a caller-owned
  // (e.g. federation-shared) Presence too, that would be a double-free —
  // the owner's later dispose() (or continued use) would touch a torn-down
  // Awareness instance.
  it('does NOT dispose a caller-supplied presenceInstance on session.dispose()', async () => {
    const sharedDoc = new Y.Doc();
    const sharedPresence = createPresence(sharedDoc, { updateRateHz: 1000 });

    const session = await createCollabSession({
      roomId: 'shared-presence-room',
      user: { id: 'u1', name: 'Alice' },
      provider: 'memory',
      presenceInstance: sharedPresence,
    });

    // Confirm the session actually bound to the shared instance, not a copy.
    expect(session.presence).toBe(sharedPresence);

    session.dispose();

    // The owner (caller) should still be able to drive the shared presence
    // after the session that borrowed it is gone.
    sharedPresence.setSelection(['wall-1']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sharedPresence.getSelf()).not.toBeNull();
    expect(sharedPresence.getSelf()?.selection).toEqual(['wall-1']);

    // Clean up the instance we own.
    sharedPresence.dispose();
  });

  it('DOES dispose a self-created presence on session.dispose()', async () => {
    const session = await createCollabSession({
      roomId: 'own-presence-room',
      user: { id: 'u2', name: 'Bob' },
      provider: 'memory',
    });

    // Let the initial setUser/setStatus patch flush (default 30Hz throttle).
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(session.presence.getSelf()).not.toBeNull();

    session.dispose();

    // Awareness.destroy() clears the local state synchronously, so a
    // session-owned presence must read back as torn down immediately.
    expect(session.presence.getSelf()).toBeNull();
  });
});
