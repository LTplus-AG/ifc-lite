/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test support: detect-and-skip guards for script tests that need something CI
 * provides and a contributor machine may not (#7030): build output from
 * `pnpm build`, the wasm runtime, a Rust component, a browser.
 *
 * Each helper returns the value `node:test` takes for `skip`: `false` to run,
 * or a message naming what is missing and the command that provides it. A
 * caller writes `test('...', { skip: skipUnlessFilesExist(...) }, ...)`.
 *
 * ON CI NOTHING EVER SKIPS. A prerequisite missing there is a defect in the job
 * (a build artifact that was not restored, a toolchain step that was dropped),
 * and a skip would turn it into a green run that tested nothing. With `CI` set
 * every helper returns `false`, the test body runs, and it fails on the
 * missing prerequisite. `CI` is read from `env` so a test can drive both sides.
 *
 * THESE ARE PRESENCE CHECKS, NOT FRESHNESS CHECKS. `skipUnlessFilesExist` asks
 * whether the named files exist; it knows nothing about when they were built
 * or from which sources. A stale `dist` from an older checkout passes it, and
 * the guarded tests then run against that old code. A `false` here means "the
 * test can start", never "the build is current".
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** True when `env` says this is a CI run (`CI` set to anything but empty, `0` or `false`). */
export function isCI(env = process.env) {
  const value = (env.CI ?? '').trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'false';
}

/**
 * `false` when every `relPaths` entry exists under `root`, or when running on
 * CI; otherwise a skip message listing the missing files and the remedy.
 * Existence only: see the header.
 *
 * @param {string} root repo root
 * @param {string[]} relPaths repo-relative files the test imports or resolves
 * @param {string} remedy command that produces them, e.g. `pnpm build`
 * @param {NodeJS.ProcessEnv} [env] environment to read `CI` from
 */
export function skipUnlessFilesExist(root, relPaths, remedy, env = process.env) {
  if (isCI(env)) return false;
  const missing = relPaths.filter((rel) => !existsSync(join(root, rel)));
  if (missing.length === 0) return false;
  return `missing here: ${missing.join(', ')}. Run \`${remedy}\` to exercise this test. CI never skips it.`;
}

/**
 * `false` when `bin args...` exits 0, or when running on CI; otherwise a skip
 * message naming the tool and the remedy. On CI the probe is not even run.
 *
 * @param {string} bin executable to probe
 * @param {string[]} args arguments that make it exit 0 when usable, e.g. `['+stable', '--version']`
 * @param {string} remedy how to install it
 * @param {NodeJS.ProcessEnv} [env] environment to read `CI` from
 * @param {{ cwd?: string, timeoutMs?: number, label?: string }} [options] where to run the probe, how long to wait, and what to call the tool in the message
 */
export function skipUnlessCommand(bin, args, remedy, env = process.env, { cwd, timeoutMs = 15_000, label } = {}) {
  if (isCI(env)) return false;
  const probe = spawnSync(bin, args, { encoding: 'utf8', timeout: timeoutMs, cwd });
  if (probe.status === 0) return false;
  return `${label ?? `\`${bin} ${args.join(' ')}\``} is not usable here. Remedy: ${remedy}. CI never skips this test.`;
}
