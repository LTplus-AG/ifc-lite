/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ProxyOptions } from 'vite';
import { REGISTRY_REFRESH_COOKIE } from './src/lib/registry/protocol';

const sessionPath = (path = '') => ['/oauth/token', '/oauth/revoke'].includes(path.split('?')[0]);
function refreshCookie(value: string): boolean {
  const parts = value.split(';').map(part => part.trim());
  const attributes = (name: string) => parts.slice(1).filter(part => part.slice(0, name.length + 1).toLowerCase() === `${name}=`).map(part => part.slice(name.length + 1));
  const paths = attributes('path'); const sites = attributes('samesite');
  return value.startsWith(`${REGISTRY_REFRESH_COOKIE}=`) && parts.some(part => part.toLowerCase() === 'httponly') &&
    paths.length === 1 && paths[0] === '/oauth/' && sites.length === 1 && sites[0].toLowerCase() === 'strict' && !attributes('domain').length;
}

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
      proxy.on('proxyReq', (forwarded, request) => {
        forwarded.removeHeader('cookie');
        if (sessionPath(request.url)) {
          const cookies = request.headers.cookie?.split(';').map(cookie => cookie.trim()).filter(cookie => cookie.startsWith(`${REGISTRY_REFRESH_COOKIE}=`));
          if (cookies?.length === 1) forwarded.setHeader('cookie', cookies[0]);
        }
      });
      proxy.on('proxyRes', (response, request) => {
        const cookies = response.headers['set-cookie']?.filter(refreshCookie);
        if (sessionPath(request.url) && cookies?.length) response.headers['set-cookie'] = cookies;
        else delete response.headers['set-cookie'];
        // Relative URLs resolve to the browser-facing origin, including alternate dev ports.
        const location = response.headers.location;
        if (location) {
          const resolved = new URL(location, upstream);
          if (resolved.origin === upstream.origin) response.headers.location = resolved.pathname + resolved.search;
        }
      });
    },
  };
  return { '^/v2(?:/|$)': options, '^/oauth/(?:config|token|revoke)(?:\\?|$)': options };
}
