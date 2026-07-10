/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { ClashReview } from '@ifc-lite/clash';
import { loadReviews, saveReviews, isMeaningfulReview } from './persistence.js';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
}

const g = globalThis as { localStorage?: unknown };
const REVIEWS_KEY = 'ifc-lite-clash-reviews';

describe('clash review persistence (#1468)', () => {
  beforeEach(() => {
    g.localStorage = new MemoryStorage();
  });

  it('returns an empty map when nothing is stored', () => {
    assert.strictEqual(loadReviews().size, 0);
  });

  it('round-trips a status + comment keyed by the durable clash-review key', () => {
    const map = new Map<string, ClashReview>([
      ['rule-a GUID_1 GUID_2', { status: 'resolved', comment: 'fixed in rev B', updatedAt: 123 }],
    ]);
    assert.deepStrictEqual(saveReviews(map), { ok: true });

    const loaded = loadReviews();
    assert.strictEqual(loaded.size, 1);
    const entry = loaded.get('rule-a GUID_1 GUID_2');
    assert.strictEqual(entry?.status, 'resolved');
    assert.strictEqual(entry?.comment, 'fixed in rev B');
    assert.strictEqual(entry?.updatedAt, 123);
  });

  it('prunes default (open, no comment) entries so storage holds only real decisions', () => {
    const map = new Map<string, ClashReview>([
      ['keep', { status: 'accepted' }],
      ['drop-open', { status: 'open' }],
      ['drop-open-blank', { status: 'open', comment: '   ' }],
    ]);
    saveReviews(map);
    const loaded = loadReviews();
    assert.deepStrictEqual([...loaded.keys()], ['keep']);
  });

  it('keeps an open clash that carries a comment (a real decision)', () => {
    saveReviews(new Map<string, ClashReview>([['k', { status: 'open', comment: 'waiting on structural' }]]));
    const entry = loadReviews().get('k');
    assert.strictEqual(entry?.status, 'open');
    assert.strictEqual(entry?.comment, 'waiting on structural');
  });

  it('drops entries with an unknown status on load (defensive validation)', () => {
    g.localStorage = new MemoryStorage();
    (g.localStorage as MemoryStorage).setItem(
      REVIEWS_KEY,
      JSON.stringify({ schemaVersion: 1, reviews: { bad: { status: 'wontfix' }, good: { status: 'resolved' } } }),
    );
    const loaded = loadReviews();
    assert.deepStrictEqual([...loaded.keys()], ['good']);
  });

  it('caps an over-long comment on load', () => {
    const long = 'x'.repeat(5000);
    (g.localStorage as MemoryStorage).setItem(
      REVIEWS_KEY,
      JSON.stringify({ schemaVersion: 1, reviews: { k: { status: 'resolved', comment: long } } }),
    );
    assert.strictEqual(loadReviews().get('k')?.comment?.length, 2000);
  });

  it('classifies meaningful reviews correctly', () => {
    assert.strictEqual(isMeaningfulReview({ status: 'resolved' }), true);
    assert.strictEqual(isMeaningfulReview({ status: 'accepted' }), true);
    assert.strictEqual(isMeaningfulReview({ status: 'open', comment: 'note' }), true);
    assert.strictEqual(isMeaningfulReview({ status: 'open' }), false);
    assert.strictEqual(isMeaningfulReview({ status: 'open', comment: '  ' }), false);
  });
});
