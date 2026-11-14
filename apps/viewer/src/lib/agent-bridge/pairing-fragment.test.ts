/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pairing link's code leaves the address bar before anything else runs
 * (#9523), and only a real pairing link is touched.
 */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { PAIRING_FRAGMENT_KEY, buildPairingUrl, parsePairingFragment } from '@ifc-lite/mcp/bridge-protocol';
import { consumePendingPairingFragment, takePairingFragment } from './pairing-fragment';

function fakeHistory() {
  const calls: { state: unknown; url?: string }[] = [];
  return {
    calls,
    state: { idx: 3 } as unknown,
    replaceState(state: unknown, _unused: string, url?: string) { calls.push({ state, url }); },
  };
}

it('strips a pairing fragment, keeping path, query and history state, and hands it out once', () => {
  const link = new URL(buildPairingUrl('https://ifclite.com/viewer?model=demo', 21517, 'ABCDE-FGHJK-MNPQR-STVWX'));
  const history = fakeHistory();
  const taken = takePairingFragment({ pathname: link.pathname, search: link.search, hash: link.hash }, history);
  assert.equal(taken, link.hash);
  assert.deepEqual(history.calls, [{ state: { idx: 3 }, url: '/viewer?model=demo' }]);
  assert.deepEqual(parsePairingFragment(consumePendingPairingFragment() ?? ''), { protocol: 1, port: 21517, code: 'ABCDE-FGHJK-MNPQR-STVWX' });
  assert.equal(consumePendingPairingFragment(), null, 'a second read gets nothing');
});

it('leaves every other URL alone', () => {
  for (const hash of ['', '#', '#/mcp', '#section=walls', '#bridge=1&code=X']) {
    const history = fakeHistory();
    assert.equal(takePairingFragment({ pathname: '/', search: '', hash }, history), null, hash);
    assert.equal(history.calls.length, 0, hash);
  }
  assert.equal(consumePendingPairingFragment(), null);
});

it('strips a malformed pairing link too, so a bad code never lingers', () => {
  const history = fakeHistory();
  assert.equal(takePairingFragment({ pathname: '/', search: '', hash: '#mcp-bridge=1&port=nope' }, history), '#mcp-bridge=1&port=nope');
  assert.deepEqual(history.calls.map((call) => call.url), ['/']);
  consumePendingPairingFragment();
});

it('a replaceState that throws still yields the fragment', () => {
  const taken = takePairingFragment({ pathname: '/', search: '', hash: '#mcp-bridge=1&port=1&code=A' },
    { state: null, replaceState() { throw new Error('SecurityError'); } });
  assert.equal(taken, '#mcp-bridge=1&port=1&code=A');
  consumePendingPairingFragment();
});

it('recognises the bridge protocol\'s own key', () => {
  const history = fakeHistory();
  assert.ok(takePairingFragment({ pathname: '/', search: '', hash: `#${PAIRING_FRAGMENT_KEY}=1` }, history));
  consumePendingPairingFragment();
});
