/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Stale-presence eviction and patch bookkeeping (`awareness/presence.ts`,
 * spec §5.4 / §7).
 *
 * Eviction is what removes a peer whose tab was closed without a clean
 * disconnect. Nothing exercised it: mutations that evicted the LOCAL peer,
 * that dropped the age comparison entirely, and that changed the default
 * window from 10s to 1ms all survived the suite. Its two neighbours —
 * the caller-supplied user colour and the authoritative `lastUpdate` —
 * were equally free.
 */

import { applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { colorForUser } from '../src/awareness/color.js';
import { createPresence, type Presence } from '../src/awareness/presence.js';

/**
 * Publish `state` onto `target`'s awareness as a REMOTE peer, by driving a
 * second Awareness instance and replaying its encoded update. Going
 * through the wire encoding is what makes the entry a peer rather than a
 * local write, which is exactly the distinction eviction turns on.
 */
function publishPeer(
  target: Presence,
  lastUpdate: number,
  name = 'Remote',
): { clientId: number; dispose: () => void } {
  const remoteDoc = new Y.Doc();
  const remote = createPresence(remoteDoc, { updateRateHz: 1000, staleAfterMs: 1_000_000 });
  remote.awareness.setLocalState({
    user: { id: name, name },
    selection: [],
    status: 'active',
    lastUpdate,
  });
  applyAwarenessUpdate(
    target.awareness,
    encodeAwarenessUpdate(remote.awareness, [remote.awareness.clientID]),
    'test',
  );
  return { clientId: remote.awareness.clientID, dispose: () => remote.dispose() };
}

describe('evictStale', () => {
  it('drops a peer older than the window and keeps a fresh one', () => {
    const doc = new Y.Doc();
    const presence = createPresence(doc, { staleAfterMs: 5_000 });
    const now = Date.now();
    const stale = publishPeer(presence, now - 60_000, 'Stale');
    const fresh = publishPeer(presence, now - 1_000, 'Fresh');

    // `getPeers()` also carries this client's own (empty) entry, so probe
    // the two remote ids rather than the map size.
    expect(presence.getPeers()[stale.clientId]).toBeDefined();
    expect(presence.getPeers()[fresh.clientId]).toBeDefined();
    presence.evictStale();

    const peers = presence.getPeers();
    expect(peers[stale.clientId]).toBeUndefined();
    expect(peers[fresh.clientId]).toBeDefined();

    stale.dispose();
    fresh.dispose();
    presence.dispose();
  });

  it('keeps a peer exactly at the window boundary (strictly older is evicted)', () => {
    const doc = new Y.Doc();
    const presence = createPresence(doc, { staleAfterMs: 5_000 });
    const atBoundary = publishPeer(presence, Date.now() - 5_000, 'Edge');

    presence.evictStale();
    // `now - lastUpdate > staleAfterMs` — a peer that reported exactly one
    // window ago is not yet stale. Timer granularity can push this past the
    // boundary, so assert only that a peer this recent is not evicted for
    // being *arbitrarily* old.
    const peers = presence.getPeers();
    expect(Object.prototype.hasOwnProperty.call(peers, String(atBoundary.clientId))).toBe(true);

    atBoundary.dispose();
    presence.dispose();
  });

  it('NEVER evicts the local peer, however long since its last patch', () => {
    // The local entry's `lastUpdate` only advances when this client
    // patches something. A user who reads the model for a minute without
    // touching it must not evict themselves out of everyone's roster.
    const doc = new Y.Doc();
    const presence = createPresence(doc, { staleAfterMs: 10 });
    presence.awareness.setLocalState({
      user: { id: 'me', name: 'Me' },
      selection: [],
      status: 'active',
      lastUpdate: Date.now() - 10 * 60 * 1000,
    });

    presence.evictStale();

    expect(presence.getSelf()).not.toBeNull();
    expect(presence.getPeers()[presence.awareness.clientID]).toBeDefined();
    presence.dispose();
  });

  it('defaults the window to 10 seconds', () => {
    // The default is what production uses — no caller in the repo passes
    // `staleAfterMs`. A peer 9s quiet is still on the roster; one 11s
    // quiet is gone.
    const doc = new Y.Doc();
    const presence = createPresence(doc);
    const now = Date.now();
    const quiet = publishPeer(presence, now - 9_000, 'Quiet');
    const gone = publishPeer(presence, now - 11_000, 'Gone');

    presence.evictStale();

    const peers = presence.getPeers();
    expect(peers[quiet.clientId]).toBeDefined();
    expect(peers[gone.clientId]).toBeUndefined();

    quiet.dispose();
    gone.dispose();
    presence.dispose();
  });
});

describe('presence patch bookkeeping', () => {
  it('keeps a caller-supplied user colour instead of the derived one', async () => {
    // A user who picked their own presence colour (or an app that colours
    // peers by discipline) must see it broadcast verbatim; the id-derived
    // colour is only a fallback.
    const doc = new Y.Doc();
    const presence = createPresence(doc, { updateRateHz: 1000 });
    presence.setUser({ id: 'louis', name: 'Louis', color: '#ff00ff' });
    await new Promise((r) => setTimeout(r, 20));

    expect(presence.getSelf()?.user.color).toBe('#ff00ff');
    presence.dispose();
  });

  it('derives a colour only when the user did not supply one', async () => {
    const doc = new Y.Doc();
    const presence = createPresence(doc, { updateRateHz: 1000 });
    presence.setUser({ id: 'louis', name: 'Louis' });
    await new Promise((r) => setTimeout(r, 20));

    expect(presence.getSelf()?.user.color).toBe(colorForUser('louis'));
    presence.dispose();
  });

  it('stamps lastUpdate itself, so a stale value in a patch cannot survive', async () => {
    // `patch()` takes an arbitrary Partial<PresenceState>. If a caller (or
    // a replayed state object) carried an old `lastUpdate`, letting it win
    // would make this client look stale to every peer and get evicted
    // mid-session.
    const doc = new Y.Doc();
    const presence = createPresence(doc, { updateRateHz: 1000 });
    const before = Date.now();
    presence.patch({ selection: ['wall-1'], lastUpdate: 1 });
    await new Promise((r) => setTimeout(r, 20));

    const self = presence.getSelf();
    expect(self?.selection).toEqual(['wall-1']);
    expect(self?.lastUpdate).toBeGreaterThanOrEqual(before);
    presence.dispose();
  });

  it('publishes within a couple of frames by default (30 Hz cap, not slower)', async () => {
    // No caller in the repo passes `updateRateHz`, so the DEFAULT is the
    // only rate production ever runs at. If it were an order of magnitude
    // slower, a peer's first selection would take a second to reach the
    // others and every cursor would visibly lag.
    const doc = new Y.Doc();
    const presence = createPresence(doc);
    presence.setSelection(['wall-1']);

    await new Promise((r) => setTimeout(r, 100));
    expect(presence.getSelf()?.selection).toEqual(['wall-1']);
    presence.dispose();
  });

  it('coalesces patches inside one throttle window into a single state', async () => {
    // The 30 Hz cap is the whole point of `enqueue`: cursor moves arrive
    // per frame, and each one must not become an awareness broadcast.
    const doc = new Y.Doc();
    const presence = createPresence(doc, { updateRateHz: 30 });
    let broadcasts = 0;
    presence.awareness.on('update', () => { broadcasts++; });

    for (let i = 0; i < 20; i++) presence.setCursor2d('plan', { x: i, y: i });
    // Nothing has been published yet — the first flush is still pending.
    expect(presence.getSelf()?.cursor2d).toBeUndefined();
    await new Promise((r) => setTimeout(r, 120));

    expect(broadcasts).toBe(1);
    expect(presence.getSelf()?.cursor2d).toEqual({ viewport: 'plan', pos: { x: 19, y: 19 } });
    presence.dispose();
  });
});
