/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  createDaluxRelayHandler,
  loadDaluxRelayConfig,
} from '../server/sources/dalux-relay.js';

export const runtime = 'edge';
export const config = { runtime: 'edge' };

const handler = createDaluxRelayHandler(loadDaluxRelayConfig(process.env), {
  fetchImpl: fetch,
});

export default handler;
