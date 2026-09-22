/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite ext init` scaffolds a starter bundle whose own starter
 * command/test must be runnable by `ifc-lite ext test` out of the box.
 *
 * Regression test: the scaffolded `hello.js` used to `export default`
 * a function named `hello`, but the extension host (and the test
 * runner) evaluate entry scripts as non-module sources and always look
 * for a plain, top-level function literally named `run` — see
 * `wrapEntrySource` in `@ifc-lite/extensions`. A freshly scaffolded
 * bundle's own starter test therefore failed for reasons unrelated to
 * what it was meant to test.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extCommand } from './ext.js';

let tmpDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ext-init-test-'));
  tmpDirs.push(dir);
  return dir;
}

describe('ext init scaffold', () => {
  it('produces a bundle whose starter test passes under ext test', async () => {
    const parent = await makeTmpDir();
    const bundleDir = join(parent, 'my-extension');

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExit(code ?? 0);
    }) as never);

    // `ext init` does not call process.exit.
    await extCommand(['init', bundleDir, '--id', 'com.example.test', '--name', 'Test Ext']);

    let testExitCode: number | undefined;
    try {
      await extCommand(['test', bundleDir]);
    } catch (err) {
      if (err instanceof ProcessExit) {
        testExitCode = err.code;
      } else {
        throw err;
      }
    }

    expect(testExitCode).toBe(0);
    expect(exitSpy).toHaveBeenCalled();

    const stdoutCalls = (process.stdout.write as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    void stdoutCalls; // ext test writes results to stderr in non-json mode.

    const stderrCalls = (process.stderr.write as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .join('');
    expect(stderrCalls).toMatch(/1 passed, 0 failed/);
    expect(stderrCalls).not.toMatch(/No tests declared/);
  });
});

class ProcessExit extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}
