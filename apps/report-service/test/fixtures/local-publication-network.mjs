/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The actual service entrypoint uses actual HTTP against the owned fixture.
// Never let a test GitHub request reach a public host or another destination.
const endpoint = new URL(process.env.REPORT_PUBLICATION_TEST_ENDPOINT);
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password)
  throw new Error('Publication fixture endpoint must be owned loopback HTTP');
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (target.origin !== 'https://api.github.com')
    throw new Error('Publication fixture forbids non-GitHub fetch destinations');
  return originalFetch(new URL(target.pathname + target.search, endpoint), init);
};
