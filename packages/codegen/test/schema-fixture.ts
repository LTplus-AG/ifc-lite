/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export const schemaSource = (file: string) => readFileSync(join(__dirname, '..', 'schemas', file), 'utf8');
