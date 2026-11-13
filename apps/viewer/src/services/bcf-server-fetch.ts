/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { FetchLike } from '@ifc-lite/bcf-api';

/** Bind one viewer operation to the API's existing injectable transport. */
export function bcfFetch(signal?: AbortSignal, send: FetchLike = (input, init) => fetch(input, init)): FetchLike {
  return async (input, init) => {
    const requestSignal = signal && init?.signal ? AbortSignal.any([signal, init.signal]) : signal ?? init?.signal;
    requestSignal?.throwIfAborted();
    const response = await send(input, { ...init, ...(requestSignal ? { signal: requestSignal } : {}) });
    // A transport may complete despite cancellation; do not retry a late 401.
    requestSignal?.throwIfAborted();
    return response;
  };
}
