/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6923: a feature's English catalogue can load with its chunk. Before it
// registers, a lazy key renders as itself (never throws); afterwards it
// resolves, interpolates and pluralises like an eager key, and a locale
// overlay still wins over the English.

import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerEnglish, registerLocale, resolve, resolveEnglish, setLocale } from './registry';
import { flowReviewEn } from './catalogues/flow-review.en';

afterEach(() => setLocale('en'));

it('resolves a lazy key only after its catalogue registered, without throwing before', () => {
  assert.equal(resolve('flowReview.digest', { digest: 'ab12' }), 'flowReview.digest');
  registerEnglish(flowReviewEn);
  assert.equal(resolve('flowReview.digest', { digest: 'ab12' }), 'Proposal ab12');
  assert.equal(resolve('flowReview.paused', { count: 2, nodes: 'a, b' }), 'The run paused at a, b. Nothing downstream of them runs until you approve this proposal.');
  assert.equal(resolveEnglish('flowReview.approve'), 'Approve and resume');
  // Eager keys are untouched.
  assert.equal(resolve('flowPanel.status.restored'), 'restored');
});

it('lets a registered locale translate a lazy key', () => {
  registerEnglish(flowReviewEn);
  registerLocale('xx', { 'flowReview.approve': 'XX approve' });
  setLocale('xx');
  assert.equal(resolve('flowReview.approve'), 'XX approve');
  assert.equal(resolve('flowReview.reject'), 'Reject');
});
