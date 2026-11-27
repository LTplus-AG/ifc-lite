/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { UNKNOWN_VERSION } from '@ifc-lite/data/node';
import type { ServerCommand } from './clients.js';

/** `npx` pinned to this release line, so the flags written here are ones it knows. */
export function serverCommand(version: string, serverArgs: string[]): ServerCommand {
  const spec = version === UNKNOWN_VERSION ? '@ifc-lite/mcp' : `@ifc-lite/mcp@^${version}`;
  return { command: 'npx', args: ['-y', spec, ...serverArgs] };
}
