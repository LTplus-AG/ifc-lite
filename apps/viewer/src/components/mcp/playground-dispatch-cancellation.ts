/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';

export const cancelledDispatch = () => new ToolExecutionError({
  code: ToolErrorCode.CANCELLED, message: 'Tool cancelled.',
});

/** Check between asynchronous phases without disguising a completed mutation as a failure. */
export function assertDispatchActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledDispatch();
}
