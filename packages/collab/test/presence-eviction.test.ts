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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  // Eviction compares `Date.now() - state.lastUpdate` against the window, and
  // `evictStale` reads the clock itself — there is no injectable `now`. With a
  // live clock, a peer built at `Date.now() - staleAfterMs` is exactly at the
  // boundary only until the next millisecond ticks, and everything in between
  // (two Y.Docs, an awareness encode and a wire replay) is real work. On a
  // loaded CI runner that is enough to cross the boundary, which is precisely
  // how this file went red. Freeze the clock so the ages under test are the
  // ages asserted; nothing here needs time to pass.
  const NOW = 1_700_000_000_000;
  beforeEach(() => { vi.useFakeTimers({ now: NOW }); });
  afterEach(() => { vi.useRealTimers(); });

  it('drops a peer older than the window and keeps a fresh one', () => {
    const doc = new Y.Doc();
    const presence = createPresence(doc, { staleAfterMs: 5_000 });
    const stale = publishPeer(presence, NOW - 60_000, 'Stale');
    const fresh = publishPeer(presence, NOW - 1_000, 'Fresh');

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
    // The clock is frozen, so these ages are exact: 5000ms and 5001ms.
    const atBoundary = publishPeer(presence, NOW - 5_000, 'Edge');
    const pastBoundary = publishPeer(presence, NOW - 5_001, 'Past');

    presence.evictStale();

    // `now - lastUpdate > staleAfterMs` — a peer that reported exactly one
    // window ago is not yet stale; one millisecond older is. Asserting both
    // sides is what pins the comparison: `>=` would evict the first, and
    // dropping the age test entirely would keep the second.
    const peers = presence.getPeers();
    expect(peers[atBoundary.clientId]).toBeDefined();
    expect(peers[pastBoundary.clientId]).toBeUndefined();

    atBoundary.dispose();
    pastBoundary.dispose();
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
      lastUpdate: NOW - 10 * 60 * 1000,
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
    const quiet = publishPeer(presence, NOW - 9_000, 'Quiet');
    const gone = publishPeer(presence, NOW - 11_000, 'Gone');

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
  // Only the default-rate test below fakes the clock; `useRealTimers` is a
  // no-op for the others and keeps a failed assertion from leaking a frozen
  // clock into the rest of the file.
  afterEach(() => { vi.useRealTimers(); });

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
    //
    // A 100ms wall-clock wait proved nothing: a 20 Hz (50ms) or even a
    // 10 Hz (100ms) default passes it too. Fake timers make the window
    // exact. The flush is scheduled at `1000 / 30` ms, so advancing one
    // whole frame — 34ms, the ceiling of that — must be enough; any
    // default slower than 30 Hz still has nothing published by then.
    vi.useFakeTimers();
    const doc = new Y.Doc();
    const presence = createPresence(doc);
    presence.setSelection(['wall-1']);

    // Throttled, not synchronous: the first flush is still pending.
    expect(presence.getSelf()?.selection).toBeUndefined();

    await vi.advanceTimersByTimeAsync(Math.ceil(1000 / 30));
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

  // The test above pins the THROTTLE but not the MERGE: every one of its 20
  // patches writes the same key, so `pendingPatch = { ...patch }` (last write
  // wins, earlier keys dropped) produces exactly the same single broadcast and
  // the same final cursor. Coalescing only means something across *different*
  // keys, which is the real frame: a selection click and the cursor move that
  // follows it land in one window, and without the merge the selection never
  // reaches the peers at all.
  it('merges patches on DIFFERENT keys inside one window, losing none', async () => {
    const doc = new Y.Doc();
    const presence = createPresence(doc, { updateRateHz: 30 });
    let broadcasts = 0;
    presence.awareness.on('update', () => { broadcasts++; });

    presence.setSelection(['wall-1']);
    presence.setCursor2d('plan', { x: 5, y: 6 });
    presence.setTool('measure');
    presence.setStatus('idle');
    await new Promise((r) => setTimeout(r, 120));

    const self = presence.getSelf();
    expect(broadcasts).toBe(1);
    expect(self?.selection).toEqual(['wall-1']);
    expect(self?.cursor2d).toEqual({ viewport: 'plan', pos: { x: 5, y: 6 } });
    expect(self?.tool).toBe('measure');
    expect(self?.status).toBe('idle');
    presence.dispose();
  });
});
