/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';

import { OAUTH_CALLBACK_CHANNEL, waitForOAuthCallback } from '../src/callback-channel.js';

/** Posts one message the way a static callback page does. */
function broadcast(message: unknown): void {
  const channel = new BroadcastChannel(OAUTH_CALLBACK_CHANNEL);
  channel.postMessage(message);
  channel.close();
}

function callbackMessage(state: string, code = 'code-1'): unknown {
  return {
    type: OAUTH_CALLBACK_CHANNEL,
    state,
    url: `https://app.example.com/oauth/msgraph/callback?code=${code}&state=${state}`,
  };
}

describe('waitForOAuthCallback', () => {
  it('resolves with the callback URL the page broadcast', async () => {
    const pending = waitForOAuthCallback({
      expectedState: 'state-a',
      timeoutMs: 2000,
      timeoutMessage: 'timed out',
    });
    broadcast(callbackMessage('state-a'));
    await expect(pending).resolves.toBe(
      'https://app.example.com/oauth/msgraph/callback?code=code-1&state=state-a',
    );
  });

  /**
   * Every waiter on this shared channel sees every message, so `state` is the
   * only thing keeping two concurrent sign-ins apart. Without the filter, the
   * first waiter to receive would consume the other provider's callback and
   * complete a flow it never started (and then fail its own CSRF check, or
   * worse, exchange a code minted for a different client).
   */
  it('ignores a callback carrying a different state, so two sign-ins cannot cross wires', async () => {
    const waiterA = waitForOAuthCallback({
      expectedState: 'state-a',
      timeoutMs: 300,
      timeoutMessage: 'A timed out',
    });
    const waiterB = waitForOAuthCallback({
      expectedState: 'state-b',
      timeoutMs: 2000,
      timeoutMessage: 'B timed out',
    });

    broadcast(callbackMessage('state-b', 'code-for-b'));

    await expect(waiterB).resolves.toContain('code=code-for-b');
    // A saw the same message and let it pass, so it has nothing and times out.
    await expect(waiterA).rejects.toThrow('A timed out');
  });

  it('ignores traffic on the channel that is not a callback message', async () => {
    const pending = waitForOAuthCallback({
      expectedState: 'state-a',
      timeoutMs: 300,
      timeoutMessage: 'timed out',
    });
    broadcast({ type: 'something-else', state: 'state-a', url: 'https://evil.example/' });
    broadcast(null);
    broadcast({ type: OAUTH_CALLBACK_CHANNEL, state: 'state-a' }); // no url
    await expect(pending).rejects.toThrow('timed out');
  });

  it('rejects with the caller-supplied message when nothing ever arrives', async () => {
    await expect(
      waitForOAuthCallback({
        expectedState: 'state-a',
        timeoutMs: 50,
        timeoutMessage: 'Microsoft sign-in timed out',
      }),
    ).rejects.toThrow('Microsoft sign-in timed out');
  });
});
