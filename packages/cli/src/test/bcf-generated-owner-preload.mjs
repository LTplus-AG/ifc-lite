/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7374 private test syscall boundary: a legitimate machine-id fixture whose
// genuine SHA256 happens to contain the owned dummy bearer. No host file changes.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const readFile = fs.readFile;
fs.readFile = async function readOwnerFixture(path, options) {
  if (path === '/etc/machine-id') return '000000000000000000000000000000be\n';
  return readFile.call(this, path, options);
};
syncBuiltinESMExports();
