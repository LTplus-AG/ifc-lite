/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `stateVectorCovers` / `roomSocketUrl` (#4446): the pure halves of the
 * "does the relay hold my seed?" probe. The socket half is exercised against
 * a real server in `@ifc-lite/collab-server`'s `relay-state.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { roomSocketUrl, stateVectorCovers } from '../src/providers/relay-state.js';

describe('stateVectorCovers', () => {
  it('is true only once every local clock is reached, per client', () => {
    const owner = new Y.Doc();
    owner.getMap('m').set('a', 1);
    owner.getMap('m').set('b', 2);
    const target = Y.encodeStateVector(owner);

    // A relay that never saw the owner holds nothing for its client.
    expect(stateVectorCovers(target, new Map())).toBe(false);
    // Behind by one write.
    const ownClock = Y.decodeStateVector(target).get(owner.clientID)!;
    expect(ownClock).toBeGreaterThan(1);
    expect(stateVectorCovers(target, new Map([[owner.clientID, ownClock - 1]]))).toBe(false);
    // Exactly caught up, and ahead (a peer wrote more), both cover.
    expect(stateVectorCovers(target, new Map([[owner.clientID, ownClock]]))).toBe(true);
    expect(stateVectorCovers(target, new Map([[owner.clientID, ownClock + 5], [999, 3]]))).toBe(true);
    // A decoded map is accepted as the target too.
    expect(stateVectorCovers(Y.decodeStateVector(target), new Map([[owner.clientID, ownClock]]))).toBe(true);
  });

  it('a relay synced from the owner covers the owner exactly', () => {
    const owner = new Y.Doc();
    owner.getMap('entities').set('/x', 'wall');
    const relay = new Y.Doc();
    Y.applyUpdate(relay, Y.encodeStateAsUpdate(owner));
    expect(stateVectorCovers(Y.encodeStateVector(owner), Y.decodeStateVector(Y.encodeStateVector(relay)))).toBe(true);
    owner.getMap('entities').set('/y', 'slab');
    expect(stateVectorCovers(Y.encodeStateVector(owner), Y.decodeStateVector(Y.encodeStateVector(relay)))).toBe(false);
  });
});

describe('roomSocketUrl', () => {
  it('dials the room path y-websocket uses, token as ?token=', () => {
    expect(roomSocketUrl('ws://127.0.0.1:1234/', 'abc', 'tok.en')).toBe('ws://127.0.0.1:1234/abc?token=tok.en');
    expect(roomSocketUrl('wss://relay.example', 'abc')).toBe('wss://relay.example/abc');
  });
});
