/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  createBcfTokenRelayHandler,
  loadBcfTokenRelayConfig,
} from '../../../server/bcf/oauth-token-relay.js';

export const runtime = 'edge';
export const config = { runtime: 'edge' };

// Served at /api/bcf/oauth/token by Vercel's file-system routing, which runs
// before vercel.json's SPA catch-all rewrite (as /api/chat already relies on).
const handler = createBcfTokenRelayHandler(loadBcfTokenRelayConfig(process.env), {
  fetchImpl: fetch,
});

export default handler;
