/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared blob store for geometry hydration (plan §4.6, §7.9).
 *
 * Server mode → `HttpBlobStore` against the collab-server `/blobs` route, so
 * every peer shares one store. Local-only mode → IndexedDB, which is shared
 * across tabs of the same origin (enough to exercise hydration without a
 * backend). The collab runtime is injected so this pulls nothing eagerly.
 */

import type { BlobStore } from '@ifc-lite/collab';

type CollabModule = typeof import('@ifc-lite/collab');

/** ws(s):// → http(s):// for the blob route base URL. */
function toHttpBase(serverUrl: string): string {
  return serverUrl.replace(/^ws/, 'http').replace(/\/$/, '');
}

export async function createSharedBlobStore(
  collab: CollabModule,
  serverUrl: string | null,
  token?: string,
): Promise<BlobStore> {
  if (serverUrl) {
    return new collab.HttpBlobStore({ baseUrl: toHttpBase(serverUrl), token });
  }
  return collab.createIndexedDbBlobStore();
}
