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
let roomId: string | null;
let stops: number;
let joined: Promise<void>;
const collab = () => ({
  collabRoomId: roomId,
  startCollab: (opts: StartCollabOptions) => { joins.push(opts); roomId = opts.roomId; return joined; },
  stopCollab: () => { stops++; roomId = null; },
}) as Pick<ViewerState, 'startCollab' | 'stopCollab' | 'collabRoomId'>;

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
  setCollabEnabledOverride(true);
  joins = [];
  roomId = null;
  stops = 0;
  joined = Promise.resolve();
  infos = [];
  console.info = (...args: unknown[]) => { infos.push(args.join(' ')); };
});

afterEach(() => {
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

it('a host request leaves the pending page room, not a room the user switched to (#10142)', () => {
  joined = new Promise(() => {}); // the page-link join never settles
  joinRoomFromPageUrl(link, collab);
  roomId = 'picked-in-the-room-panel';
  openProcessedModel({ sha256: 'a'.repeat(64), bytes: 0, name: 'host.ifc' });
  assert.equal(stops, 0, "the user's room stays");
  resetProcessedModelRequestsForTests();
  roomId = 'r1';
  openProcessedModel({ sha256: 'a'.repeat(64), bytes: 0, name: 'host.ifc' });
  assert.equal(stops, 1, 'the pending page room is left');
});
