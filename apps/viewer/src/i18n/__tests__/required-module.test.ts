/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requiredModule } from './required-module';

test('#8890 missing production becomes an assertion inside the test', async () => {
  await assert.rejects(requiredModule(() => import(new URL('./absent-fixture.mjs', import.meta.url).href),
    'shipping locale must load'), { code: 'ERR_ASSERTION', message: 'shipping locale must load' });
});

test('#8890 loader preserves implementation failures rather than hiding them as absence', async () => {
  const failure = new SyntaxError('invalid catalogue');
  await assert.rejects(requiredModule(async () => { throw failure; }, 'shipping locale must load'),
    error => error === failure);
});
