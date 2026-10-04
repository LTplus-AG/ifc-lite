/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Blob and layer-registry authorizers derived from the websocket `authenticate` hook. */

import { canWrite, type AuthenticateFn, type Principal } from './auth.js';
import type { BlobAuthorizeFn } from './blob-route.js';
import type { RegistryAuthorizeFn } from './layer-registry-route.js';

/**
 * Pseudo-room scope handed to `authenticate` for blob requests. Blobs are
 * content-addressed and not room-scoped, but reusing the WS `authenticate`
 * hook keeps the credential scheme identical. Custom authenticators that
 * key off roomId see this sentinel and can grant/deny blob access
 * explicitly.
 */
const BLOB_AUTH_ROOM = '__blobs__';

/**
 * Derive a blob authorizer from the websocket `authenticate` hook so the
 * blob route shares the same token scheme. A null principal (bad/missing
 * token) is rejected; PUT/DELETE additionally require write capability,
 * GET/HEAD/list accept any authenticated principal.
 */
/** Room key the registry authorizer authenticates against. */
const REGISTRY_AUTH_ROOM = '__layer_registry__';

/**
 * Derive a registry authorizer from the websocket `authenticate` hook —
 * same scheme as blobs: reads accept any authenticated principal, writes
 * (POST/PUT) require write capability. The principal flows through so the
 * merge endpoint records it as the acting resolver.
 */
export function makeRegistryAuthorizer(authenticate: AuthenticateFn): RegistryAuthorizeFn {
  return async (token, method) => {
    let principal: Principal | null;
    try {
      principal = await authenticate(token, REGISTRY_AUTH_ROOM);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[collab-server] registry auth threw:', err);
      return null;
    }
    if (!principal) return null;
    if ((method === 'POST' || method === 'PUT' || method === 'DELETE') && !canWrite(principal)) {
      return null;
    }
    return principal;
  };
}

export function makeBlobAuthorizer(authenticate: AuthenticateFn): BlobAuthorizeFn {
  return async (token, method, _hash) => {
    let principal: Principal | null;
    try {
      principal = await authenticate(token, BLOB_AUTH_ROOM);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[collab-server] blob auth threw:', err);
      return false;
    }
    if (!principal) return false;
    if (method === 'PUT' || method === 'DELETE') return canWrite(principal);
    return true;
  };
}
