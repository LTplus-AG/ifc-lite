/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createSavedHistoryStorage } from './saved-history';

interface Entry { id: string; value: number }
const isEntry = (value: unknown): value is Entry => typeof value === 'object' && value !== null
  && 'id' in value && typeof value.id === 'string' && 'value' in value && typeof value.value === 'number';
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let data: Map<string, string>;
let blocked: Set<string>;
let unreadable: boolean;
beforeEach(() => {
  data = new Map(); blocked = new Set(); unreadable = false;
  const storage: Storage = {
    getItem: (key) => { if (unreadable) throw new Error('Storage blocked'); return data.get(key) ?? null; },
    setItem: (key, value) => { if (blocked.has(key)) throw new DOMException('Full', 'QuotaExceededError'); data.set(key, value); },
    removeItem: (key) => { data.delete(key); }, clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null, get length() { return data.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
});
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});
const history = () => createSavedHistoryStorage('history', isEntry, 'saved reports');

describe('saved history recovery (#6506, #6500)', () => {
  it('distinguishes absent/valid empty history from inaccessible storage', () => {
    assert.deepEqual(history().read(), { entries: [], issue: null });
    data.set('history', '[]');
    assert.deepEqual(history().read(), { entries: [], issue: null });
    unreadable = true;
    assert.deepEqual(history().read(), { entries: [], issue: 'unavailable' });
    assert.equal(history().save([{ id: 'new', value: 1 }]).ok, false);
    assert.equal(data.get('history'), '[]');
  });
  for (const bytes of ['{ corrupt', '{"id":"not-an-array"}']) {
    it(`archives invalid history before allowing recovery: ${bytes}`, () => {
      data.set('history', bytes); data.set('history:unreadable', 'older recovery');
      assert.deepEqual(history().read(), { entries: [], issue: 'recovered' });
      assert.equal(data.get('history:unreadable'), 'older recovery');
      assert.equal(data.get('history:unreadable:2'), bytes);
      assert.equal(history().save([{ id: 'new', value: 2 }]).ok, true);
      assert.deepEqual(history().read().entries, [{ id: 'new', value: 2 }]);
    });
  }
  it('preserves complete partial/duplicate bytes and restores valid neighbours across reload', () => {
    const bytes = '[{"id":"bad"},{"id":"a","value":1},{"id":"a","value":2},null,{"id":"b","value":3}]';
    data.set('history', bytes);
    const expected = [{ id: 'a', value: 1 }, { id: 'b', value: 3 }];
    assert.deepEqual(history().read(), { entries: expected, issue: 'recovered' });
    assert.equal(data.get('history:unreadable'), bytes);
    assert.deepEqual(history().read(), { entries: expected, issue: null });
  });
  it('refuses every overwrite until original partial bytes can be backed up', () => {
    const bytes = '[{"id":"a","value":1},null]';
    data.set('history', bytes); blocked.add('history:unreadable');
    const store = history();
    assert.deepEqual(store.read(), { entries: [{ id: 'a', value: 1 }], issue: 'blocked' });
    assert.equal(store.save([{ id: 'replacement', value: 9 }]).issue, 'blocked');
    assert.equal(data.get('history'), bytes);
    blocked.clear();
    assert.deepEqual(store.save([{ id: 'replacement', value: 9 }]), { ok: true, issue: 'recovered', entries: [{ id: 'replacement', value: 9 }] });
    assert.deepEqual(store.save([{ id: 'replacement', value: 10 }]), { ok: true, issue: null, entries: [{ id: 'replacement', value: 10 }] });
    assert.equal(data.get('history:unreadable'), bytes);
    assert.deepEqual(history().read().entries, [{ id: 'replacement', value: 10 }]);
  });
  it('reports failed valid-neighbour restoration instead of claiming a durable recovery', () => {
    const bytes = '[{"id":"a","value":1},null]';
    data.set('history', bytes); blocked.add('history');
    assert.deepEqual(history().read(), { entries: [{ id: 'a', value: 1 }], issue: 'unavailable' });
    assert.equal(data.get('history:unreadable'), bytes);
    assert.equal(data.has('history'), false);
  });
  it('archives original bytes even when a validator throws undefined after a valid entry', () => {
    const bytes = '[{"id":"a","value":1},null]';
    data.set('history', bytes);
    const store = createSavedHistoryStorage('history', (value: unknown): value is Entry => {
      if (value === null) throw undefined;
      return isEntry(value);
    }, 'saved reports');
    assert.deepEqual(store.read(), { entries: [{ id: 'a', value: 1 }], issue: 'recovered' });
    assert.equal(data.get('history:unreadable'), bytes);
  });
  it('reports recovery when external corruption is archived during an ordinary save', () => {
    const store = history(); store.read();
    data.set('history', 'cross-tab corrupt bytes');
    assert.deepEqual(store.save([{ id: 'new', value: 1 }]), { ok: true, issue: 'recovered', entries: [{ id: 'new', value: 1 }] });
    assert.equal(data.get('history:unreadable'), 'cross-tab corrupt bytes');
    assert.deepEqual(store.save([{ id: 'new', value: 2 }]), { ok: true, issue: null, entries: [{ id: 'new', value: 2 }] });
  });
  it('retains newly readable neighbours after an unavailable initial read while normal deletes still work', () => {
    data.set('history', '[{"id":"old","value":1}]');
    unreadable = true;
    const store = history();
    assert.equal(store.read().issue, 'unavailable');
    unreadable = false;
    const outcome = store.save([{ id: 'new', value: 2 }]);
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.entries, [{ id: 'old', value: 1 }, { id: 'new', value: 2 }]);
    assert.deepEqual(history().read().entries, outcome.entries);
    const deleted = store.save([{ id: 'new', value: 2 }]);
    assert.deepEqual(deleted.entries, [{ id: 'new', value: 2 }]);
    assert.deepEqual(history().read().entries, deleted.entries);
  });
  it('retains unreadable-history reconciliation after a quota-failed first retry', () => {
    data.set('history', '[{"id":"old","value":1},{"id":"edited","value":2}]');
    unreadable = true;
    const store = history(); store.read();
    unreadable = false; blocked.add('history');
    const incoming = [{ id: 'edited', value: 9 }, { id: 'new', value: 3 }];
    const refused = store.save(incoming);
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.entries, [{ id: 'old', value: 1 }, ...incoming]);
    assert.deepEqual(JSON.parse(data.get('history')!), [{ id: 'old', value: 1 }, { id: 'edited', value: 2 }]);
    blocked.clear();
    const retried = store.save(incoming);
    assert.equal(retried.ok, true);
    assert.deepEqual(retried.entries, refused.entries);
    assert.deepEqual(history().read().entries, retried.entries);
  });
  it('retains discovered neighbours when unavailable storage becomes a blocked partial archive', () => {
    const bytes = '[{"id":"old","value":1},null]';
    data.set('history', bytes); unreadable = true;
    const store = history(); store.read();
    unreadable = false; blocked.add('history:unreadable');
    const incoming = [{ id: 'new', value: 2 }];
    const refused = store.save(incoming);
    assert.equal(refused.issue, 'blocked');
    assert.deepEqual(refused.entries, [{ id: 'old', value: 1 }, ...incoming]);
    assert.equal(data.get('history'), bytes);
    blocked.clear();
    const retry = store.save(incoming);
    assert.equal(retry.ok, true);
    assert.deepEqual(retry.entries, refused.entries);
    assert.equal(data.get('history:unreadable'), bytes);
    assert.deepEqual(history().read().entries, retry.entries);
  });
  it('checks external corruption before a later save rather than trusting the initial read', () => {
    const store = history(); assert.equal(store.read().issue, null);
    data.set('history', 'external corrupt bytes'); blocked.add('history:unreadable');
    assert.equal(store.save([{ id: 'a', value: 1 }]).ok, false);
    assert.equal(data.get('history'), 'external corrupt bytes');
  });
});
