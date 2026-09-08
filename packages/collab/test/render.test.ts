/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { cursorScreenPosition, peerVisuals } from '../src/awareness/render.js';
import type { PresenceMap } from '../src/awareness/presence.js';

const FRESH = Date.now();

const peerA = {
  user: { id: 'louis', name: 'Louis' },
  selection: ['wall'],
  status: 'active',
  lastUpdate: FRESH,
  cursor2d: { viewport: 'plan', pos: { x: 100, y: 200 } },
} as const;

const peerB = {
  user: { id: 'agent-1', name: 'GPT (agent)', color: '#ff00ff' },
  selection: [],
  status: 'active',
  lastUpdate: FRESH,
  tool: 'edit',
} as const;

const peerStale = {
  user: { id: 'sven', name: 'Sven' },
  selection: [],
  status: 'active',
  lastUpdate: FRESH - 30_000,
} as const;

describe('peerVisuals', () => {
  it('resolves color, label, opacity', () => {
    const peers: PresenceMap = { 1: peerA, 2: peerB } as unknown as PresenceMap;
    const visuals = peerVisuals(peers, { staleAfterMs: 10_000, now: () => FRESH });
    expect(visuals).toHaveLength(2);
    const louis = visuals.find((v) => v.clientId === 1)!;
    expect(louis.label).toBe('Louis');
    expect(louis.color).toMatch(/^#/);
    expect(louis.opacity).toBe(1);
    const agent = visuals.find((v) => v.clientId === 2)!;
    expect(agent.label).toBe('GPT (agent) — edit');
    expect(agent.color).toBe('#ff00ff');
  });

  it('marks stale peers and fades opacity', () => {
    const peers: PresenceMap = { 7: peerStale } as unknown as PresenceMap;
    const visuals = peerVisuals(peers, { staleAfterMs: 10_000, now: () => FRESH });
    expect(visuals[0].isStale).toBe(true);
    expect(visuals[0].opacity).toBeLessThan(1);
  });

  it('treats idleMs exactly at staleAfterMs as stale (`>=`, not `>`)', () => {
    // `peerStale` above sits at idleMs=30_000 vs a 10_000 threshold — miles
    // past the boundary either way, so it can't distinguish `idleMs >=
    // staleAfterMs` from `idleMs > staleAfterMs`. Pin the exact-equality
    // case: `now - lastUpdate` land exactly on staleAfterMs.
    const atThreshold = {
      user: { id: 'exact', name: 'Exact' },
      selection: [],
      status: 'active',
      lastUpdate: FRESH - 10_000,
    } as const;
    const peers: PresenceMap = { 8: atThreshold } as unknown as PresenceMap;
    const visuals = peerVisuals(peers, { staleAfterMs: 10_000, now: () => FRESH });
    expect(visuals[0].isStale).toBe(true);
  });

  it('excludes the local peer when excludeClientId is set', () => {
    const peers: PresenceMap = { 1: peerA, 2: peerB } as unknown as PresenceMap;
    const visuals = peerVisuals(peers, { excludeClientId: 1, now: () => FRESH });
    expect(visuals.map((v) => v.clientId)).toEqual([2]);
  });

  it('returns visuals sorted ascending by clientId (`.sort()` at the end of peerVisuals)', () => {
    // JS engines always iterate a plain object's integer-like keys in
    // ascending numeric order (ECMA-262 OrdinaryOwnPropertyKeys), REGARDLESS
    // of the order they were assigned in the object literal below — so
    // `Object.entries(peers)` inside peerVisuals is already ascending before
    // its own `.sort()` runs. That made a prior version of this test file
    // vacuous: every existing case here either used `.find()` (order-blind)
    // or had 0-1 elements in the result, so a reversed comparator
    // (`b.clientId - a.clientId`) inside peerVisuals passed every assertion.
    // `.sort()` fully re-sorts from scratch though — it doesn't defer to
    // whatever order its input arrived in — so asserting the OUTPUT order
    // here still discriminates a broken comparator even though we can't
    // control the pre-sort order of the loop that builds `out`.
    const peers: PresenceMap = {
      30: peerB,
      10: peerA,
      20: peerStale,
    } as unknown as PresenceMap;
    const visuals = peerVisuals(peers, { staleAfterMs: 10_000, now: () => FRESH });
    expect(visuals).toHaveLength(3); // more than one element, so ordering is meaningful
    expect(visuals.map((v) => v.clientId)).toEqual([10, 20, 30]);
  });
});

describe('cursorScreenPosition', () => {
  it('returns the 2D cursor when viewport matches', () => {
    const peers: PresenceMap = { 1: peerA } as unknown as PresenceMap;
    const visuals = peerVisuals(peers, { now: () => FRESH });
    expect(cursorScreenPosition(visuals[0], 'plan')).toEqual({ x: 100, y: 200 });
    expect(cursorScreenPosition(visuals[0], 'elevation')).toBeNull();
  });
});
