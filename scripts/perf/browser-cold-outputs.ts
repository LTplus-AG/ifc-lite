/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Output destinations may live outside the per-run screenshot/log directory. */
export function prepareBrowserOutputs(results: string, jsonl: string, report: string | null): void {
  if (existsSync(jsonl) || (report && existsSync(report)) || (existsSync(results) && readdirSync(results).length)) {
    throw new Error('Refusing to overwrite existing browser run artifacts; choose fresh output paths');
  }
  mkdirSync(results, { recursive: true });
  mkdirSync(dirname(jsonl), { recursive: true });
  if (report) mkdirSync(dirname(report), { recursive: true });
  writeFileSync(jsonl, '', { flag: 'wx' });
}
