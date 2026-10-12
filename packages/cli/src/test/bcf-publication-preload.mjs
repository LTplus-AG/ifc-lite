/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7374: keep the production HTTPS/exact-host gate while retaining effects
// in the independent controlled loopback HTTP peer outside the CLI process.
const baseUrl = process.env.IFCLITE_TEST_BCF_PEER;
if (!baseUrl) throw new Error('Controlled BCF peer is missing');
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://bcf-peer.test') throw new Error('Unexpected test network target');
  return realFetch(baseUrl + url.pathname.replace(/^\/bcf/, '') + url.search, init);
};
