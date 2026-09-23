/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5209 finding 1: `ext test` exits 0 for a bundle declaring zero tests,
 * because `process.exit(summary.failed === 0 ? 0 : 1)` treats "nothing to
 * fail" the same as "everything passed". The correct guard shape already
 * lives in `packages/ids`: `checks.length > 0 && counts.fail === 0`
 * (delivery-checks.ts:290-291, delivery-report.ts:63). `extTestCommand`
 * (ext.ts) now uses the equivalent `summary.results.length > 0 &&
 * summary.failed === 0` and mirrors the signal into `--json` via an `ok`
 * field, since `{"results":[],"passed":0,"failed":0}` alone gives a script
 * nothing to branch on.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extCommand } from './ext.js';

class ProcessExited extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/** Run `extCommand`, capturing stdout/stderr and turning `process.exit` into a throw. */
async function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number | undefined }> {
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  const exitFn = process.exit;
  let stdout = '';
  let stderr = '';
  let code: number | undefined;
  process.stdout.write = (chunk: unknown) => {
    stdout += String(chunk);
    return true;
  };
  process.stderr.write = (chunk: unknown) => {
    stderr += String(chunk);
    return true;
  };
  process.exit = ((c?: number) => {
    throw new ProcessExited(c);
  }) as never;
  try {
    await extCommand(args);
    code = 0;
  } catch (err) {
    if (err instanceof ProcessExited) {
      code = err.code;
    } else {
      throw err;
    }
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    process.exit = exitFn;
  }
  return { stdout, stderr, code };
}

const dirs: string[] = [];
function bundleDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ifclite-ext-test-'));
  dirs.push(d);
  return join(d, 'bundle');
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The runner (packages/extensions/src/testing/runner.ts:235) always wraps the
// tested command's entry with `entryFnName: 'run'`, regardless of the
// manifest's own command-handler name. The scaffold's own hello.js (`export
// default async function hello`) both uses `export` — unsupported by
// wrapEntrySource, see host/source-wrap.ts:17-20 — and is named `hello`, not
// `run`, so it fails every declared test regardless of pass/fail intent.
// Replace it with a plain `run` entry so PASSING_TEST/FAILING_TEST below
// exercise the pass/fail branches themselves, not this pre-existing scaffold
// mismatch (out of scope for #5209 — reported, not fixed here).
const RUN_ENTRY = `function run(ctx) { return { message: 'hello' }; }`;

/** Scaffold a starter bundle (via `ext init`, so it stays in lockstep with the
 *  real manifest shape) and optionally rewrite its `tests` array. */
async function scaffold(tests?: unknown[]): Promise<string> {
  const dir = bundleDir();
  const init = await run(['init', dir]);
  expect(init.code).toBe(0);
  if (tests !== undefined) {
    const manifestPath = join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.tests = tests;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    writeFileSync(join(dir, 'src', 'commands', 'hello.js'), RUN_ENTRY, 'utf-8');
  }
  return dir;
}

const PASSING_TEST = {
  name: 'hello returns a message',
  command: 'ext.starter.hello',
  fixture: 'residential-small',
  expect: { jsonShape: { message: 'hello' } },
};

const FAILING_TEST = {
  name: 'hello returns something it does not',
  command: 'ext.starter.hello',
  fixture: 'residential-small',
  expect: { jsonShape: { message: 'goodbye' } },
};

describe('ext test — zero declared tests is not a pass (#5209 finding 1)', () => {
  it('exits non-zero for a bundle with no `tests` in its manifest', async () => {
    // Explicitly forced to an empty `tests` array rather than relying on
    // whatever `ext init` currently scaffolds: once #5211 lands, the
    // scaffold declares one real (passing) test, and this case must still
    // exercise the zero-tests path.
    const dir = await scaffold([]);
    const { stderr, code } = await run(['test', dir]);
    // RED before the fix: `summary.failed === 0` is vacuously true for zero
    // results, so this used to be `code === 0`.
    expect(code).not.toBe(0);
    expect(stderr).toContain('No tests declared in manifest.');
  });

  it('exits non-zero for a bundle with an empty `tests` array', async () => {
    const dir = await scaffold([]);
    const { code } = await run(['test', dir]);
    expect(code).not.toBe(0);
  });

  it('--json distinguishes zero declared tests from a pass', async () => {
    // Same reasoning as above: force zero declared tests explicitly rather
    // than relying on the as-scaffolded manifest.
    const dir = await scaffold([]);
    const { stdout, code } = await run(['test', dir, '--json']);
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.results).toEqual([]);
    expect(parsed.passed).toBe(0);
    expect(parsed.failed).toBe(0);
    // RED before the fix: no field distinguished this from a real pass; a
    // `--json` consumer had `passed: 0, failed: 0` and nothing to branch on.
    expect(parsed.ok).toBe(false);
  });
});

describe('ext test — no-regression pins', () => {
  it('a bundle WITH passing tests still exits 0', async () => {
    const dir = await scaffold([PASSING_TEST]);
    const { stderr, code } = await run(['test', dir]);
    expect(code).toBe(0);
    expect(stderr).toContain('1 passed, 0 failed');
  });

  it('a bundle WITH passing tests still reports ok: true in --json', async () => {
    const dir = await scaffold([PASSING_TEST]);
    const { stdout, code } = await run(['test', dir, '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.passed).toBe(1);
    expect(parsed.failed).toBe(0);
    expect(parsed.ok).toBe(true);
  });

  it('a bundle with a FAILING test still exits 1', async () => {
    const dir = await scaffold([FAILING_TEST]);
    const { stderr, code } = await run(['test', dir]);
    expect(code).toBe(1);
    expect(stderr).toContain('0 passed, 1 failed');
  });

  it('a bundle with a FAILING test still reports ok: false in --json', async () => {
    const dir = await scaffold([FAILING_TEST]);
    const { stdout, code } = await run(['test', dir, '--json']);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.passed).toBe(0);
    expect(parsed.failed).toBe(1);
    expect(parsed.ok).toBe(false);
  });
});
