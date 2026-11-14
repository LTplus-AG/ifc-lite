/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A share link (`?room=…&t=…`) joins its room, unless a host has asked for its
 * own model: joining would load the room's model over the host's, so the room
 * is refused like `?processed=` and `?model=`, and logged once.
 */

import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StartCollabOptions } from '@/store/slices/collabSlice';
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
const start = (opts: StartCollabOptions) => { joins.push(opts); };

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
  setCollabEnabledOverride(true);
  joins = [];
  infos = [];
  console.info = (...args: unknown[]) => { infos.push(args.join(' ')); };
});

afterEach(() => {
  console.info = realInfo;
  resetProcessedModelRequestsForTests();
});

it('joins the linked room when no host asked for a model', () => {
  joinRoomFromPageUrl(link, start);
  assert.deepEqual(joins, [{ roomId: 'r1', role: 'viewer', token: 'tok' }]);
  assert.deepEqual(infos, []);
});

it('refuses the room once a host asked for its model, logging it once', () => {
  openProcessedModel({ sha256: 'a'.repeat(64), bytes: 0, name: 'host.ifc' });
  joinRoomFromPageUrl(link, start);
  joinRoomFromPageUrl(link, start);
  assert.deepEqual(joins, [], 'no join attempt: the viewer stays on the host model');
  assert.equal(infos.length, 1);
  assert.match(infos[0], /\?room= in the page URL is ignored/);
});

it('does nothing without a room or with collaboration off', () => {
  joinRoomFromPageUrl('?t=tok', start);
  setCollabEnabledOverride(false);
  joinRoomFromPageUrl(link, start);
  assert.deepEqual(joins, []);
});
