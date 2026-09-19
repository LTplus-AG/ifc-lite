/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, collectSecretEnvValues } from './redact-secrets.mjs';

test('redacts a literal env value whose name matches TOKEN/KEY/SECRET/PASSWORD', () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-super-secret-oauth-value' };
  const out = redactSecrets('before sk-super-secret-oauth-value after', { env });
  assert.equal(out, 'before [redacted] after');
});

test('is a no-op when the excerpt contains no secret', () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-super-secret-oauth-value' };
  const out = redactSecrets('nothing sensitive here', { env });
  assert.equal(out, 'nothing sensitive here');
});

test('matches every secret-shaped env name, not only the ones this file names', () => {
  const env = {
    OPENROUTER_API_KEY: 'or-value-one',
    SOME_SECRET_THING: 'secret-value-two',
    DB_PASSWORD: 'password-value-three',
    MY_TOKEN: 'token-value-four',
    UNRELATED_VAR: 'not-a-secret',
  };
  const out = redactSecrets('or-value-one secret-value-two password-value-three token-value-four not-a-secret', { env });
  assert.equal(out, '[redacted] [redacted] [redacted] [redacted] not-a-secret');
});

test('ignores trivially short env values so it cannot mangle unrelated text', () => {
  const env = { API_KEY: 'ab' };
  const out = redactSecrets('grab a cab', { env });
  assert.equal(out, 'grab a cab');
});

test('redacts a longer value fully even when a shorter value is a prefix of it', () => {
  const env = { TOKEN_A: 'abcdef', TOKEN_B: 'abcdefghij' };
  const out = redactSecrets('abcdefghij', { env });
  assert.equal(out, '[redacted]');
});

test('redacts sk-ant- and sk-or- shaped tokens by pattern even with no matching env var', () => {
  const out = redactSecrets('key is sk-ant-api03-abcXYZ_123-abc and sk-or-v1-abc123XYZ_-here', { env: {} });
  assert.equal(out, 'key is [redacted] and [redacted]');
});

test('collectSecretEnvValues excludes non-string and empty-ish values', () => {
  const values = collectSecretEnvValues({
    API_KEY: 'a-real-secret-value',
    EMPTY_TOKEN: '',
    SHORT_KEY: 'abcd',
    NUMERIC_TOKEN: undefined,
  });
  assert.deepEqual(values, ['a-real-secret-value']);
});

test('handles null/undefined input without throwing, matching the sanitizers convention of an empty string', () => {
  assert.equal(redactSecrets(undefined, { env: {} }), '');
  assert.equal(redactSecrets(null, { env: {} }), '');
});
