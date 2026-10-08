/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Owned local peer for recorded coordinator journeys, never a production BCF service.
import { startLocalBcfServer, LOCAL_BCF_PROJECT, LOCAL_BCF_TOKEN } from '../apps/viewer/src/test/bcf-http-server.js';

const server = await startLocalBcfServer();
console.log(`Local BCF test URL: ${server.baseUrl}`);
console.log(`Local project ID: ${LOCAL_BCF_PROJECT}`);
console.log(`Synthetic test token: ${LOCAL_BCF_TOKEN}`);
console.log('In-memory test data only; Ctrl+C closes the server and discards it.');
let closing = false;
const close = (): void => {
  if (closing) return;
  closing = true;
  void server.close().catch(error => { console.error('Local BCF test server shutdown failed', error); process.exitCode = 1; });
};
process.once('SIGINT', close);
process.once('SIGTERM', close);
