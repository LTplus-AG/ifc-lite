/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IDSDocument } from '@ifc-lite/ids';
import type { Dirent } from 'node:fs';

export interface PrecisionCaseDeps {
  parseIDS(xml: string): IDSDocument;
  readdirSync(path: string): string[];
  readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  readFileSync(path: string, encoding: 'utf8'): string;
  join(...parts: string[]): string;
}

export function loadPrecisionCases(pkgDir: string, deps: PrecisionCaseDeps): { file: string; ids: IDSDocument }[];
