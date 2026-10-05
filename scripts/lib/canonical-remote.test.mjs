/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalBaseArgs, findCanonicalRemote } from './canonical-remote.mjs';

const remote = (name, url) => `${name}\t${url} (fetch)\n${name}\t${url} (push)\n`;

test('the canonical repository is found under any remote name and in https, scp-style and ssh:// forms', () => {
  for (const url of [
    'https://github.com/LTplus-AG/ifc-lite.git',
    'https://github.com/LTplus-AG/ifc-lite',
    'https://github.com/LTplus-AG/ifc-lite/',
    'git@github.com:LTplus-AG/ifc-lite.git',
    'ssh://git@github.com/LTplus-AG/ifc-lite',
    'https://x-access-token:abc@github.com/LTplus-AG/ifc-lite',
    'https://github.com/ltplus-ag/ifc-lite.git',
  ]) {
    assert.equal(findCanonicalRemote(remote('upstream', url)), 'upstream', url);
  }
});

test('a fork, a sibling repository and a path that merely contains the name are not the canonical repository', () => {
  for (const url of [
    'https://github.com/BIMvoice/ifc-lite.git',
    'https://github.com/LTplus-AG/ifc-lite-fork.git',
    'https://github.com/Evil-LTplus-AG/ifc-lite.git',
    'https://github.com/BIMvoice/LTplus-AG/ifc-lite.git',
  ]) {
    assert.equal(findCanonicalRemote(remote('origin', url)), null, url);
  }
});

test('with a fork as origin the canonical remote wins; with both pointing at it the first listed is used', () => {
  const forkAndCanonical = remote('origin', 'https://github.com/BIMvoice/ifc-lite.git') + remote('upstream', 'git@github.com:LTplus-AG/ifc-lite.git');
  assert.equal(findCanonicalRemote(forkAndCanonical), 'upstream');
  const both = remote('origin', 'https://github.com/LTplus-AG/ifc-lite.git') + remote('upstream', 'https://github.com/LTplus-AG/ifc-lite.git');
  assert.equal(findCanonicalRemote(both), 'origin');
});

test('only a fetch URL counts', () => {
  assert.equal(findCanonicalRemote('origin\thttps://github.com/LTplus-AG/ifc-lite.git (push)\n'), null);
});

test('the base follows the matched remote; with none, CI keeps the checker default and a contributor machine skips with a message', () => {
  const fork = remote('origin', 'https://github.com/BIMvoice/ifc-lite.git');
  assert.deepEqual(canonicalBaseArgs(remote('upstream', 'https://github.com/LTplus-AG/ifc-lite.git'), false), { args: ['--base', 'upstream/main'] });
  assert.deepEqual(canonicalBaseArgs(fork, true), { args: [] });
  assert.deepEqual(canonicalBaseArgs('', true), { args: [] });
  const local = canonicalBaseArgs(fork, false);
  assert.equal(local.args, undefined);
  assert.match(local.skip, /LTplus-AG\/ifc-lite/);
});
