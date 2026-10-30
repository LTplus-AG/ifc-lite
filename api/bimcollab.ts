/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  createBimcollabRelayHandler,
  loadBimcollabRelayConfig,
} from '../server/sources/bimcollab-relay.js';

export const runtime = 'edge';
export const config = { runtime: 'edge' };

const handler = createBimcollabRelayHandler(loadBimcollabRelayConfig(process.env), {
  fetchImpl: fetch,
});

export default handler;
