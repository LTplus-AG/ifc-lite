/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getPlaygroundModel } from './playground-model.js';

test('playground defaults to the current Opus model and migrates a saved Opus 5 selection (#6097)', () => {
  const key = 'ifc-lite:playground-model:v1';
  const prior = localStorage.getItem(key);
  try {
    localStorage.removeItem(key);
    assert.equal(getPlaygroundModel(), 'claude-opus-5-5');

    localStorage.setItem(key, 'claude-opus-5');
    assert.equal(getPlaygroundModel(), 'claude-opus-5-5');
  } finally {
    if (prior === null) localStorage.removeItem(key);
    else localStorage.setItem(key, prior);
  }
});
