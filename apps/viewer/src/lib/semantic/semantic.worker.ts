/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { executeValidation, type ValidationJob } from './validation-job';

self.onmessage = async (event: MessageEvent<ValidationJob>) => {
  try { self.postMessage({ ok: true, value: await executeValidation(event.data) }); }
  catch (error) { self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
};
