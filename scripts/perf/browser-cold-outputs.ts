/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Output destinations may live outside the per-run screenshot/log directory. */
export function prepareBrowserOutputs(results: string, jsonl: string, report: string | null): void {
  mkdirSync(results, { recursive: true });
  mkdirSync(dirname(jsonl), { recursive: true });
  if (report) mkdirSync(dirname(report), { recursive: true });
}
