/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BYOK API key storage had no test at all. Real logic worth pinning:
 *  - `sanitize` trims and type-guards whatever localStorage returns, so a
 *    corrupted/foreign value degrades to empty strings rather than throwing
 *    or leaking a non-string into the rest of the app.
 *  - `hasAnyApiKey` is an OR across the two providers: either key alone
 *    must be enough.
 *  - `updateApiKeys` merges onto the existing config (a caller updating
 *    just one key must not clobber the other).
 */

import '../test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getApiKeys,
  updateApiKeys,
  clearApiKeys,
  hasAnthropicKey,
  hasOpenaiKey,
  hasAnyApiKey,
} from './api-keys.js';

describe('api-keys', () => {
  beforeEach(() => {
    clearApiKeys();
  });

  it('returns an empty config when nothing is stored', () => {
    assert.deepEqual(getApiKeys(), { anthropicKey: '', openaiKey: '' });
  });

  it('trims whitespace on save', () => {
    updateApiKeys({ anthropicKey: '  sk-ant-abc  ' });
    assert.equal(getApiKeys().anthropicKey, 'sk-ant-abc');
  });

  it('updating one key preserves the other', () => {
    updateApiKeys({ anthropicKey: 'sk-ant-abc' });
    updateApiKeys({ openaiKey: 'sk-oai-xyz' });
    assert.deepEqual(getApiKeys(), { anthropicKey: 'sk-ant-abc', openaiKey: 'sk-oai-xyz' });
  });

  it('sanitizes a corrupted stored value back to empty strings instead of throwing', () => {
    localStorage.setItem('ifc-lite:api-keys:v1', JSON.stringify({ anthropicKey: 42, openaiKey: null }));
    assert.deepEqual(getApiKeys(), { anthropicKey: '', openaiKey: '' });
  });

  it('sanitizes non-JSON stored garbage to the empty config', () => {
    localStorage.setItem('ifc-lite:api-keys:v1', 'not json');
    assert.deepEqual(getApiKeys(), { anthropicKey: '', openaiKey: '' });
  });

  it('hasAnthropicKey / hasOpenaiKey reflect only their own provider', () => {
    updateApiKeys({ anthropicKey: 'sk-ant-abc' });
    assert.equal(hasAnthropicKey(), true);
    assert.equal(hasOpenaiKey(), false);
  });

  it('hasAnyApiKey is true when only the anthropic key is set', () => {
    updateApiKeys({ anthropicKey: 'sk-ant-abc' });
    assert.equal(hasAnyApiKey(), true);
  });

  it('hasAnyApiKey is true when only the openai key is set', () => {
    updateApiKeys({ openaiKey: 'sk-oai-xyz' });
    assert.equal(hasAnyApiKey(), true);
  });

  it('hasAnyApiKey is false when neither key is set', () => {
    assert.equal(hasAnyApiKey(), false);
  });

  it('clearApiKeys resets both keys', () => {
    updateApiKeys({ anthropicKey: 'a', openaiKey: 'b' });
    clearApiKeys();
    assert.deepEqual(getApiKeys(), { anthropicKey: '', openaiKey: '' });
  });
});
