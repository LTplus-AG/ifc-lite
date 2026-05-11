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

  it('excludes the local peer when excludeClientId is set', () => {
    const peers: PresenceMap = { 1: peerA, 2: peerB } as unknown as PresenceMap;
    const visuals = peerVisuals(peers, { excludeClientId: 1, now: () => FRESH });
    expect(visuals.map((v) => v.clientId)).toEqual([2]);
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
