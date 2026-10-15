/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveNpmCommand } from './npm-command.js';

/** Resolve the entire dependency graph together, without running install scripts. */
export function createDependencyLock(targetDir: string): void {
  const { command, args } = resolveNpmCommand(['install', '--package-lock-only', '--ignore-scripts',
    '--strict-peer-deps', '--no-audit', '--no-fund']);
  try {
    execFileSync(command, args, { cwd: targetDir, stdio: 'pipe', timeout: 120000 });
    const lock: unknown = JSON.parse(readFileSync(join(targetDir, 'package-lock.json'), 'utf8'));
    if (!lock || typeof lock !== 'object' || !('packages' in lock) ||
        !lock.packages || typeof lock.packages !== 'object' || !('' in lock.packages)) {
      throw new Error('npm did not produce a dependency lock with a root package');
    }
  } catch (cause) {
    throw new Error('Could not resolve a compatible scaffold dependency set. Check npm registry access and peer requirements.', { cause });
  }
}
