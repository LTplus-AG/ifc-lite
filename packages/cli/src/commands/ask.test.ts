/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite ask <file> "<question>" --json` must not exit 0 when the matched
 * recipe throws.
 *
 * `askCommand`'s recipe-execution catch (ask.ts) branches on `--json`: the
 * non-JSON path calls `fatal()`, which hard-exits 1; the JSON path prints
 * `{ error }` and falls through with no exit code set at all, so the process
 * exits 0 — a build pipeline reading only the exit code sees success on a
 * question that could not be answered. Same shape as the `ids --json`
 * always-exit-0 defect.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createHeadlessContext = vi.hoisted(() => vi.fn());
vi.mock('../loader.js', () => ({ createHeadlessContext }));

const { askCommand } = await import('./ask.js');

describe('askCommand when the matched recipe throws', () => {
  let stdout: string;
  let stderr: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let previousExitCode: number | string | null | undefined;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    previousExitCode = process.exitCode;
    process.exitCode = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('process.exit called');
    });
    // A recipe throwing mid-execution (e.g. a backend/geometry failure) is
    // exactly what the shared try/catch in askCommand is there for; a `bim`
    // whose `query()` throws reaches it the same way a real failure would.
    createHeadlessContext.mockResolvedValue({
      bim: {
        query: () => {
          throw new Error('backend query failed');
        },
      },
      store: { schemaVersion: 'IFC4' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = previousExitCode;
  });

  it('the human path hard-exits non-zero', async () => {
    await expect(askCommand(['model.ifc', 'how many walls'])).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('the --json path must also report failure via the exit code', async () => {
    await askCommand(['model.ifc', 'how many walls', '--json']);

    const parsed = JSON.parse(stdout);
    expect(parsed.error).toBeTruthy();
    // This is the assertion the current code fails: nothing sets
    // process.exitCode (and process.exit is never called) on the --json path.
    expect(process.exitCode).not.toBe(0);
  });
});
