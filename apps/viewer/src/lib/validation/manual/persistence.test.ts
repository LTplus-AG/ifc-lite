/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKLIST_VERSION, type ChecklistTemplate } from './checklist.js';
import { loadManualLibrary, saveManualLibrary } from './persistence.js';
import { emptyManualLibrary, type ManualChecklistLibrary } from './library.js';

const LIBRARY_KEY = 'ifc-lite:validation:manual-library';
const ANSWERS_KEY = 'ifc-lite:validation:manual-answers';
const CHECKLIST_KEY = 'ifc-lite:validation:manual-checklist';
const template: ChecklistTemplate = { version: CHECKLIST_VERSION, name: 'Weekly', groups: [{ id: 'g', name: 'G', items: [{ id: 'i', text: 'Origin agrees with survey' }] }] };

beforeEach(() => { localStorage.clear(); loadManualLibrary(); localStorage.clear(); });

describe('manual checklist library persistence (#6507)', () => {
  it('prunes empty decisions while retaining warning and comment-only evidence per instance and model', () => {
    const library: ManualChecklistLibrary = { version: 1, activeId: 'a', checklists: [
      { id: 'a', template, answers: { 'fp-a': { i: { status: 'warning', updatedAt: 5 }, empty: { status: null, updatedAt: 5 } }, 'fp-b': { i: { status: null, comment: 'ask the architect', updatedAt: 6 } } } },
      { id: 'b', template: { ...template, name: 'Structure' }, answers: { 'fp-a': { i: { status: 'pass', updatedAt: 7 } } } },
    ] };
    assert.deepEqual(saveManualLibrary(library), { ok: true });
    const loaded = loadManualLibrary().library;
    assert.deepEqual(loaded.checklists[0].answers, { 'fp-a': { i: { status: 'warning', updatedAt: 5 } }, 'fp-b': { i: { status: null, comment: 'ask the architect', updatedAt: 6 } } });
    assert.deepEqual(loaded.checklists[1].answers['fp-a'].i, { status: 'pass', updatedAt: 7 });
  });

  it('migrates the old template and verdicts together, preserving original item and model identities', () => {
    localStorage.setItem(CHECKLIST_KEY, JSON.stringify(template));
    localStorage.setItem(ANSWERS_KEY, JSON.stringify({ schemaVersion: 1, models: { fp: { i: { status: 'fail', comment: 'Survey differs', updatedAt: 1 } } } }));
    const first = loadManualLibrary();
    assert.equal(first.error, null);
    assert.equal(first.library.checklists.length, 1);
    assert.deepEqual(first.library.checklists[0].template, template);
    assert.equal(first.library.checklists[0].answers.fp.i.comment, 'Survey differs');
    assert.equal(first.library.activeId, first.library.checklists[0].id);
    assert.equal(localStorage.getItem(CHECKLIST_KEY), null);
    assert.equal(localStorage.getItem(ANSWERS_KEY), null);
    // A stale old-viewer write cannot migrate twice or replace live instances.
    localStorage.setItem(CHECKLIST_KEY, JSON.stringify({ ...template, name: 'Stale old viewer' }));
    assert.deepEqual(loadManualLibrary().library, first.library);
  });

  it('keeps old answers whose template was closed for the first actual imported template', () => {
    localStorage.setItem(ANSWERS_KEY, JSON.stringify({ schemaVersion: 1, models: { fp: { i: { status: 'warning', updatedAt: 1 } } } }));
    const loaded = loadManualLibrary().library;
    assert.equal(loaded.activeId, null);
    assert.deepEqual(loaded.checklists, []);
    assert.equal(loaded.pendingLegacyAnswers?.fp.i.status, 'warning');
    assert.equal(loadManualLibrary().library.pendingLegacyAnswers?.fp.i.status, 'warning');
  });

  it('drops an unknown legacy verdict instead of guessing and preserves a valid neighbor', () => {
    localStorage.setItem(ANSWERS_KEY, JSON.stringify({ schemaVersion: 1, models: { fp: { i: { status: 'maybe', updatedAt: 1 }, valid: { status: 'fail', updatedAt: 1 } } } }));
    assert.deepEqual(loadManualLibrary().library.pendingLegacyAnswers, { fp: { valid: { status: 'fail', updatedAt: 1 } } });
  });

  it('archives malformed template or library data before permitting a fresh write', () => {
    localStorage.setItem(CHECKLIST_KEY, '{ not json');
    assert.deepEqual(loadManualLibrary().library, emptyManualLibrary());
    assert.equal(localStorage.getItem(`${CHECKLIST_KEY}:unreadable`), '{ not json');
    localStorage.setItem(LIBRARY_KEY, '{ bad library');
    assert.deepEqual(loadManualLibrary().library, emptyManualLibrary());
    assert.equal(localStorage.getItem(`${LIBRARY_KEY}:unreadable`), '{ bad library');
    assert.deepEqual(saveManualLibrary(emptyManualLibrary()), { ok: true });
    assert.equal(localStorage.getItem(`${LIBRARY_KEY}:unreadable`), '{ bad library');
  });

  it('does not delete migration inputs when storage refuses the replacement record', () => {
    localStorage.setItem(CHECKLIST_KEY, JSON.stringify(template));
    localStorage.setItem(ANSWERS_KEY, JSON.stringify({ schemaVersion: 1, models: {} }));
    const original = localStorage.setItem;
    Object.defineProperty(localStorage, 'setItem', { configurable: true, value: () => { throw new Error('quota'); } });
    try {
      const loaded = loadManualLibrary();
      assert.deepEqual(loaded.error, { ok: false, reason: 'quota' });
      assert.deepEqual(loaded.library.checklists[0].template, template);
      assert.ok(localStorage.getItem(CHECKLIST_KEY));
      assert.ok(localStorage.getItem(ANSWERS_KEY));
    } finally { Object.defineProperty(localStorage, 'setItem', { configurable: true, value: original }); }
    assert.equal(loadManualLibrary().library.checklists.length, 1);
    assert.equal(localStorage.getItem(CHECKLIST_KEY), null);
  });

  it('retains file-supplied property-like item identifiers as ordinary own data', () => {
    const answers = JSON.parse('{"fp":{"__proto__":{"status":"pass","updatedAt":1}}}') as Record<string, Record<string, { status: 'pass'; updatedAt: number }>>;
    const library: ManualChecklistLibrary = { version: 1, activeId: 'a', checklists: [{ id: 'a', template: { ...template, groups: [{ id: 'g', name: 'G', items: [{ id: '__proto__', text: 'Name from imported checklist' }] }] }, answers }] };
    assert.deepEqual(saveManualLibrary(library), { ok: true });
    const loaded = loadManualLibrary().library.checklists[0].answers.fp;
    assert.ok(Object.hasOwn(loaded, '__proto__'));
    assert.equal(loaded.__proto__.status, 'pass');
    assert.equal(Object.getPrototypeOf(loaded), Object.prototype);
  });
});
