/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRegistryAddress } from './connection';

test('complete local registry and model/release addresses normalize to the pinned connection', () => {
  assert.deepEqual(parseRegistryAddress('localhost:5000'), { origin: 'http://127.0.0.1:5000', repository: undefined, reference: undefined });
  for (const address of ['http://localhost:5000/project/model:issued', 'oci://127.0.0.1:5000/project/model:issued', 'http://127.0.0.1:5000/v2/project/model/manifests/issued']) {
    assert.deepEqual(parseRegistryAddress(address), { origin: 'http://127.0.0.1:5000', repository: 'project/model', reference: 'issued' });
  }
  const digest = `sha256:${'a'.repeat(64)}`;
  assert.equal(parseRegistryAddress(`127.0.0.1:5000/project/model@${digest}`).reference, digest);
});

test('pasted addresses cannot change the proxy destination or carry credentials and ambiguous references', () => {
  for (const address of ['https://remote.example/project/model', 'http://127.0.0.1:6000', 'http://user:password@localhost:5000', 'http://localhost:5000/?token=secret', 'localhost:5000/project/model:', 'localhost:5000/project/model@bad@extra', 'localhost:5000/Project/model']) {
    assert.throws(() => parseRegistryAddress(address), address);
  }
});
