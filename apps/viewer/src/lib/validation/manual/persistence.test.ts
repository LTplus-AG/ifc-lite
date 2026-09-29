/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Manual-validation answers and working checklist in localStorage (#6401). */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKLIST_VERSION, type ChecklistTemplate } from './checklist.js';
import { loadManualAnswers, loadWorkingChecklist, saveManualAnswers, saveWorkingChecklist } from './persistence.js';

const ANSWERS_KEY = 'ifc-lite:validation:manual-answers';
const CHECKLIST_KEY = 'ifc-lite:validation:manual-checklist';

describe('manual validation persistence (#6401)', () => {
  beforeEach(() => localStorage.clear());

  it('keeps answers per model fingerprint and prunes entries with neither verdict nor comment', () => {
    const result = saveManualAnswers({
      'fp-a': { i1: { status: 'pass', updatedAt: 5 }, i2: { status: null, updatedAt: 5 } },
      'fp-b': { i1: { status: null, comment: 'ask the architect', updatedAt: 6 } },
      'fp-c': { i1: { status: null, comment: '   ', updatedAt: 7 } },
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(loadManualAnswers(), {
      'fp-a': { i1: { status: 'pass', updatedAt: 5 } },
      'fp-b': { i1: { status: null, comment: 'ask the architect', updatedAt: 6 } },
    });
  });

  it('drops an answer with an unknown verdict instead of guessing', () => {
    localStorage.setItem(ANSWERS_KEY, JSON.stringify({ schemaVersion: 1, models: { fp: { i1: { status: 'maybe', updatedAt: 1 }, i2: { status: 'fail', updatedAt: 1 } } } }));
    assert.deepEqual(loadManualAnswers(), { fp: { i2: { status: 'fail', updatedAt: 1 } } });
  });

  it('moves unreadable answers aside rather than overwriting them on the next save', () => {
    localStorage.setItem(ANSWERS_KEY, '{ not json');
    assert.deepEqual(loadManualAnswers(), {});
    assert.equal(localStorage.getItem(`${ANSWERS_KEY}:unreadable`), '{ not json');
    assert.deepEqual(saveManualAnswers({ fp: { i1: { status: 'pass', updatedAt: 1 } } }), { ok: true });
    assert.equal(localStorage.getItem(`${ANSWERS_KEY}:unreadable`), '{ not json');
  });

  it('keeps the working checklist across a reload, and forgets it when closed', () => {
    const template: ChecklistTemplate = { version: CHECKLIST_VERSION, name: 'Weekly', groups: [{ id: 'g', name: 'G', items: [{ id: 'i', text: 'x' }] }] };
    saveWorkingChecklist(template);
    assert.deepEqual(loadWorkingChecklist(), template);
    saveWorkingChecklist(null);
    assert.equal(localStorage.getItem(CHECKLIST_KEY), null);
    assert.equal(loadWorkingChecklist(), null);
  });
});
