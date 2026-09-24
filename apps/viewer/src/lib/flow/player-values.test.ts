/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clearPlayerValues, loadPlayerValues, savePlayerValues } from './player-values.js';

class MemoryStorage {
  readonly store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
}

class ThrowingStorage {
  getItem(): string | null { throw new Error('storage disabled'); }
  setItem(): void { throw new Error('storage disabled'); }
  removeItem(): void { throw new Error('storage disabled'); }
}

const g = globalThis as { localStorage?: unknown };

describe('player-values — flavor persistence (#5167)', () => {
  beforeEach(() => {
    g.localStorage = new MemoryStorage();
  });

  it('round-trips the raw values entered for a graph', () => {
    savePlayerValues('graph-a', { 'n.value': '7' });
    assert.deepEqual(loadPlayerValues('graph-a'), { 'n.value': '7' });
  });

  it('a different graph id never sees another graph\'s last-used values', () => {
    savePlayerValues('graph-a', { 'n.value': '7' });
    assert.deepEqual(loadPlayerValues('graph-b'), {});
  });

  it('nothing stored yet reads as an empty record, not a throw', () => {
    assert.deepEqual(loadPlayerValues('unknown'), {});
  });

  it('clearing drops only that graph\'s values', () => {
    savePlayerValues('graph-a', { x: '1' });
    savePlayerValues('graph-b', { y: '2' });
    clearPlayerValues('graph-a');
    assert.deepEqual(loadPlayerValues('graph-a'), {});
    assert.deepEqual(loadPlayerValues('graph-b'), { y: '2' });
  });

  it('a failed write is swallowed, not thrown, so the panel never crashes on it', () => {
    g.localStorage = new ThrowingStorage();
    assert.doesNotThrow(() => savePlayerValues('graph-a', { x: '1' }));
    assert.doesNotThrow(() => clearPlayerValues('graph-a'));
    assert.deepEqual(loadPlayerValues('graph-a'), {});
  });

  it('malformed stored JSON reads as empty rather than throwing', () => {
    (g.localStorage as MemoryStorage).setItem('ifc-lite-flow-player:graph-a', 'not json');
    assert.deepEqual(loadPlayerValues('graph-a'), {});
  });
});
