/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** `?room=` joins its room, unless a host asked for its own model (then refused, logged once). */

import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StartCollabOptions } from '@/store/slices/collabSlice';
import type { ViewerState } from '@/store';
import { setCollabEnabledOverride } from './config';
import { joinRoomFromPageUrl } from './deep-link-join';
import { openProcessedModel, resetProcessedModelRequestsForTests } from '@/lib/processed-model';
import { deferred, type Deferred } from '@/test/race';
import { beginCollabAttempt, liveCollabAttempt } from './session-attempt';

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
  removeItem(key: string): void { this.store.delete(key); }
}

const link = '?room=r1&t=tok';
let joins: StartCollabOptions[];
let infos: string[];
const realInfo = console.info;
const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let stops: number;
let joined: Deferred<void>;
const collab = (): Pick<ViewerState, 'startCollab' | 'stopCollab'> => ({
  startCollab: async (opts: StartCollabOptions) => { joins.push(opts); beginCollabAttempt(opts.roomId); await joined.promise; },
  stopCollab: () => { stops++; liveCollabAttempt()?.retire(); },
});

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
  setCollabEnabledOverride(true);
  joins = [];
  stops = 0;
  joined = deferred();
  joined.resolve();
  infos = [];
  console.info = (...args: unknown[]) => { infos.push(args.join(' ')); };
});

afterEach(async () => {
  joined.resolve();
  await joined.promise;
  liveCollabAttempt()?.retire();
  console.info = realInfo;
  if (realStorage) Object.defineProperty(globalThis, 'localStorage', realStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  resetProcessedModelRequestsForTests();
});

it('joins the linked room when no host asked for a model', () => {
  joinRoomFromPageUrl(link, collab);
  assert.deepEqual(joins, [{ roomId: 'r1', role: 'viewer', token: 'tok' }]);
  assert.deepEqual(infos, []);
});

it('refuses the room once a host asked for its model, logging it once', () => {
  openProcessedModel({ sha256: 'a'.repeat(64), bytes: 0, name: 'host.ifc' });
  joinRoomFromPageUrl(link, collab);
  joinRoomFromPageUrl(link, collab);
  assert.deepEqual(joins, [], 'no join attempt: the viewer stays on the host model');
  assert.equal(infos.length, 1);
  assert.match(infos[0], /\?room= in the page URL is ignored/);
});

it('does nothing without a room or with collaboration off', () => {
  joinRoomFromPageUrl('?t=tok', collab);
  setCollabEnabledOverride(false);
  joinRoomFromPageUrl(link, collab);
  assert.deepEqual(joins, []);
});

const hostAsks = () => openProcessedModel({ sha256: 'a'.repeat(64), bytes: 0, name: 'host.ifc' });

it('a host request leaves the page room while it is still joining (#10142)', () => {
  joined = deferred();
  joinRoomFromPageUrl(link, collab);
  hostAsks();
  assert.equal(stops, 1);
});

for (const [room, what] of [['picked-in-the-room-panel', 'switched to'], ['r1', 'left and rejoined']] as const) {
  it(`a host request keeps a room the user ${what} while the link was joining (#10142)`, () => {
    joined = deferred();
    joinRoomFromPageUrl(link, collab);
    beginCollabAttempt(room); // the user's own join retires the link's attempt
    hostAsks();
    assert.equal(stops, 0);
  });
}


it('a host request keeps a manual rejoin after the page room finished joining (#10469)', async () => {
  joinRoomFromPageUrl(link, collab);
  await joined.promise;
  const manual = beginCollabAttempt('r1');
  hostAsks();
  assert.equal(stops, 0);
  assert.equal(liveCollabAttempt(), manual);
  assert.equal(manual.live, true);
});
