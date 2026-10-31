/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { registryTokenSession, RegistryError } from './protocol';
import { registryJsonReply } from './session-exchange';

export async function redeemRegistryShare(origin: string, secret: string, signal: AbortSignal) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new RegistryError('Invalid share link.');
  const reply = await registryJsonReply(await fetch(new URL('/shares/redeem', origin), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret }), credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
  }));
  const authorization = registryTokenSession(reply, null, '');
  if (authorization.session.authorizationType !== 'share') throw new RegistryError('Invalid share response.');
  return { ...authorization, shareSecret: secret };
}
