/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  createBuildagilRelayHandler,
  loadBuildagilRelayConfig,
} from '../server/sources/buildagil-relay.js';

export const runtime = 'edge';
export const config = { runtime: 'edge' };

const handler = createBuildagilRelayHandler(loadBuildagilRelayConfig(process.env), {
  fetchImpl: fetch,
});

export default handler;
