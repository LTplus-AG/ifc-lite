/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { doorRows } from './common.mjs';

export type WorkerResult =
  | { ok: true; doors: ReturnType<typeof doorRows> }
  | { ok: false; code: string; message: string };
