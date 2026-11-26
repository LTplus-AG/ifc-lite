/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `@ifc-lite/mcp` version pin install writes, and when an existing entry
 * may have its pin moved without --force. Both live here so they stay in step.
 */

import { UNKNOWN_VERSION } from '@ifc-lite/data/node';
import type { ServerCommand } from './clients.js';
import { canonical, replacedEntry } from './merge.js';

/** The pins `serverCommand` writes: bare, or `^x.y.z` with any prerelease. */
const OUR_PIN = /^@ifc-lite\/mcp(?:@\^(\d+)\.(\d+)\.(\d+)(?:[-+][\w.+-]*)?)?$/;

/** The entry with its one install-written pin taken out, and that pin's x.y.z. */
function unpin(e: object): { rest: string; version?: number[] } | undefined {
  const { args } = e as { args?: unknown };
  if (!Array.isArray(args)) return undefined;
  const pins = args.filter((x): x is string => typeof x === 'string' && x.startsWith('@ifc-lite/mcp'));
  const m = pins.length === 1 ? OUR_PIN.exec(pins[0]) : null;
  if (!m) return undefined;
  return {
    rest: canonical({ ...e, args: args.map((x) => (x === pins[0] ? '@ifc-lite/mcp' : x)) }),
    version: m[1] === undefined ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])],
  };
}

/**
 * True when `entry` differs from `existing` only by a newer install-written
 * pin (strictly newer x.y.z). Bare to pinned, a downgrade, a prerelease of
 * the same x.y.z, or a hand-picked pin such as `@1.2.3` is the user's call.
 */
export function onlyPinDiffers(existing: unknown, entry: Record<string, unknown>): boolean {
  if (typeof existing !== 'object' || existing === null) return false;
  const before = unpin(existing);
  const after = unpin(replacedEntry(existing, entry));
  if (!before?.version || !after?.version || before.rest !== after.rest) return false;
  const b = before.version;
  const n = after.version;
  const i = b.findIndex((v, k) => v !== n[k]);
  return i >= 0 && n[i] > b[i];
}

/** `npx` pinned to this release line, so the flags written here are ones it knows. */
export function serverCommand(version: string, serverArgs: string[]): ServerCommand {
  const spec = version === UNKNOWN_VERSION ? '@ifc-lite/mcp' : `@ifc-lite/mcp@^${version}`;
  return { command: 'npx', args: ['-y', spec, ...serverArgs] };
}
