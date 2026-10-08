/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { humanizeModelSlug } from './models';

// The hosted free models were shown as "Glm 5 3 Flash" in the selector.
test('model slugs keep version numbers and known acronyms readable', () => {
  assert.equal(humanizeModelSlug('glm-5.3-flash'), 'GLM 5.3 Flash');
  assert.equal(humanizeModelSlug('qwen3.7-flash'), 'Qwen3.7 Flash');
  assert.equal(humanizeModelSlug('qwen3-coder-next'), 'Qwen3 Coder Next');
  assert.equal(humanizeModelSlug('gpt-oss-120b:free'), 'GPT OSS 120b');
  assert.equal(humanizeModelSlug('gemini-2.5-pro'), 'Gemini 2.5 Pro');
});
