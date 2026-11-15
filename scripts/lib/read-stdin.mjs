// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readSync } from 'node:fs';

/**
 * Read stdin without Node's vulnerable UTF-8 readFileSync path (nodejs/node#66341).
 * Remove this workaround once both the fleet and CI Node versions include the
 * fix from nodejs/node#66939.
 */
export function readStdinUtf8() {
  const chunks = [];
  const chunk = Buffer.allocUnsafe(16 * 1024);
  while (true) {
    let bytesRead;
    try {
      bytesRead = readSync(0, chunk, 0, chunk.length, null);
    } catch (error) {
      if (error?.code === 'EAGAIN') continue;
      throw error;
    }
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString('utf8');
}
