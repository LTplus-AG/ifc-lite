/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { handleCompressionRequest } from './geometry-compression-handler.js';

const workerScope = self as unknown as Pick<Worker, 'onmessage' | 'postMessage'>;
workerScope.onmessage = (event: MessageEvent<unknown>) => {
  void handleCompressionRequest(event.data, (response, transfers) => workerScope.postMessage(response, transfers))
    .catch((error: unknown) => {
      // Invalid protocol / failed reply is terminal; surface a real worker error.
      setTimeout(() => { throw error; }, 0);
    });
};
