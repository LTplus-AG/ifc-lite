/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { act } from 'react';

/**
 * Let the load window close after the store settled: it closes one painted
 * frame later, in a task behind that frame (hooks/loadWindow.ts), so the
 * whole-model consumers do not delay the settled frame. Await this after the
 * store change that ends a load, before asserting settled values.
 */
export async function settleLoadWindow(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
}
