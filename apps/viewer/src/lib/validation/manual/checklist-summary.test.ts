/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Ring counts and geometry for manual validation (#6401). */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKLIST_VERSION, type ChecklistTemplate, type ManualAnswerMap } from './checklist.js';
import { summarizeChecklist } from './checklist-summary.js';
import { passPercent, ringSegments } from './ring.js';

const TEMPLATE: ChecklistTemplate = {
  version: CHECKLIST_VERSION,
  name: 'c',
  groups: [
    { id: 'g1', name: 'A', items: [{ id: 'a1', text: '' }, { id: 'a2', text: '' }, { id: 'a3', text: '' }, { id: 'a4', text: '' }] },
    { id: 'g2', name: 'B', items: [{ id: 'b1', text: '' }] },
  ],
};

const ANSWERS: ManualAnswerMap = {
  a1: { status: 'pass', updatedAt: 1 },
  a2: { status: 'warning', updatedAt: 1 },
  a3: { status: null, comment: 'will look tomorrow', updatedAt: 1 },
  b1: { status: 'fail', updatedAt: 1 },
  // An item deleted from the template after it was answered.
  gone: { status: 'pass', updatedAt: 1 },
};

describe('manual validation counts (#6401)', () => {
  it('counts a warning on its own, never as a pass, and a comment-only item as unanswered', () => {
    const { groups, overall } = summarizeChecklist(TEMPLATE, ANSWERS);
    assert.deepEqual(groups.get('g1'), { total: 4, pass: 1, fail: 0, warning: 1, unanswered: 2 });
    assert.deepEqual(groups.get('g2'), { total: 1, pass: 0, fail: 1, warning: 0, unanswered: 0 });
    // The orphaned "gone" answer does not inflate the overall pass count.
    assert.deepEqual(overall, { total: 5, pass: 1, fail: 1, warning: 1, unanswered: 2 });
    assert.equal(passPercent(overall), 20);
  });
});

describe('ring geometry (#6401)', () => {
  const r = 10;
  const circumference = 2 * Math.PI * r;

  it('lays the buckets out in fixed order and, with the gaps added back, covers the whole circle', () => {
    const counts = { total: 4, pass: 1, fail: 1, warning: 1, unanswered: 1 };
    const segs = ringSegments(counts, r, 2);
    assert.deepEqual(segs.map((s) => s.bucket), ['pass', 'warning', 'fail', 'unanswered']);
    const covered = segs.reduce((sum, s) => sum + s.length + 2, 0);
    assert.ok(Math.abs(covered - circumference) < 1e-9);
    assert.ok(Math.abs(segs[2].offset - circumference / 2) < 1e-9);
  });

  it('draws one bucket as a full circle with no gap, and an empty checklist as no segments', () => {
    const [only] = ringSegments({ total: 3, pass: 3, fail: 0, warning: 0, unanswered: 0 }, r, 2);
    assert.ok(Math.abs(only.length - circumference) < 1e-9);
    assert.deepEqual(ringSegments({ total: 0, pass: 0, fail: 0, warning: 0, unanswered: 0 }, r), []);
  });
});
