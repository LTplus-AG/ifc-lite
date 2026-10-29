/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ProxyOptions } from 'vite';

/** Only distribution and OAuth discovery/exchange cross this fixed-target development proxy. */
export function registryProxy(target: string): Record<string, ProxyOptions> {
  const upstream = new URL(target);
  if (upstream.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(upstream.hostname) || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error('IFC_REGISTRY_TARGET must be a loopback HTTP origin.');
  }
  const options: ProxyOptions = {
    target: upstream.origin,
    changeOrigin: true,
    configure(proxy) {
      proxy.on('proxyReq', request => { request.removeHeader('cookie'); });
      proxy.on('proxyRes', response => {
        delete response.headers['set-cookie'];
        // Relative URLs resolve to the browser-facing origin, including alternate dev ports.
        const location = response.headers.location;
        if (location) {
          const resolved = new URL(location, upstream);
          if (resolved.origin === upstream.origin) response.headers.location = resolved.pathname + resolved.search;
        }
      });
    },
  };
  return { '^/v2(?:/|$)': options, '^/oauth/(?:config|token)(?:\\?|$)': options };
}
