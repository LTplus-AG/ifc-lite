/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Keep npm's Windows command-shim invocation consistent across scaffold steps. */
export function resolveNpmCommand(args: string[]): { command: string; args: string[] } {
  return process.platform === 'win32'
    ? { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...args] }
    : { command: 'npm', args };
}
