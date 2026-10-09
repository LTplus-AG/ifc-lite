/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Golden output and exit codes for `ifc-lite ids audit | lint | fmt | diff |
 * explain` (IDS-115, IDS-116).
 *
 * The output IS the contract here: CI steps parse `--json` and people read
 * the text in build logs, so each case pins stdout, stderr and the exit
 * code against a file under `__golden__/`. Regenerate deliberately with
 * `pnpm --filter @ifc-lite/cli exec vitest run -u src/commands/ids-authoring.golden.test.ts`
 * and review the diff. The commands run in-process through `idsCommand`,
 * so the subcommand dispatch is part of what is pinned.
 */

import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { idsCommand } from './ids.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, '../__fixtures__/ids');
const fixture = (name: string) => join(FIXTURES, name);

interface Run {
  stdout: string;
  stderr: string;
  exit: number;
}

async function run(args: string[]): Promise<Run> {
  let stdout = '';
  let stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  process.exitCode = undefined;
  try {
    await idsCommand(args);
  } finally {
    vi.restoreAllMocks();
  }
  const exit = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  // Fixture paths differ per checkout; the golden files say <fixtures>.
  const scrub = (s: string) => s.split(FIXTURES).join('<fixtures>');
  return { stdout: scrub(stdout), stderr: scrub(stderr), exit };
}

function golden(r: Run): string {
  return `exit: ${r.exit}\n--- stdout\n${r.stdout}--- stderr\n${r.stderr}`;
}

afterEach(() => {
  process.exitCode = undefined;
});

const CASES: Array<[string, string[], number]> = [
  ['audit-clean', ['audit', fixture('doors-clean.ids')], 0],
  ['audit-typo', ['audit', fixture('doors-typo.ids')], 1],
  ['audit-typo-json', ['audit', fixture('doors-typo.ids'), '--json'], 1],
  ['audit-broken', ['audit', fixture('broken.ids')], 1],
  ['lint-clean', ['lint', fixture('doors-clean.ids')], 0],
  ['lint-typo', ['lint', fixture('doors-typo.ids')], 1],
  ['lint-typo-json', ['lint', fixture('doors-typo.ids'), '--json'], 1],
  ['lint-typo-fail-never', ['lint', fixture('doors-typo.ids'), '--fail-on', 'never'], 0],
  ['lint-typo-rules', ['lint', fixture('doors-typo.ids'), '--rules', 'IDSL-VAL-006'], 0],
  ['lint-typo-fail-info', ['lint', fixture('doors-typo.ids'), '--rules', 'IDSL-VAL-006', '--fail-on', 'info'], 1],
  ['lint-typo-severity-off', ['lint', fixture('doors-typo.ids'), '--severity', 'IDSL-PROP-001=off'], 0],
  ['lint-broken', ['lint', fixture('broken.ids')], 2],
  ['lint-model', ['lint', fixture('doors-clean.ids'), '--model', 'm.ifc'], 2],
  ['lint-unknown-rule', ['lint', fixture('doors-clean.ids'), '--rules', 'IDSL-NOPE-001'], 2],
  ['fmt-clean-check', ['fmt', fixture('doors-clean.ids'), '--check'], 0],
  ['fmt-typo-check', ['fmt', fixture('doors-typo.ids'), '--check'], 1],
  ['fmt-typo-stdout', ['fmt', fixture('doors-typo.ids')], 0],
  ['fmt-author-lossy', ['fmt', fixture('doors-author.ids')], 2],
  ['fmt-broken', ['fmt', fixture('broken.ids')], 2],
  ['fmt-check-write', ['fmt', fixture('doors-clean.ids'), '--check', '--write'], 2],
  ['diff-same', ['diff', fixture('doors-clean.ids'), fixture('doors-clean.ids')], 0],
  ['diff-text', ['diff', fixture('doors-clean.ids'), fixture('doors-rev-b.ids')], 1],
  ['diff-json', ['diff', fixture('doors-clean.ids'), fixture('doors-rev-b.ids'), '--json'], 1],
  ['diff-md', ['diff', fixture('doors-clean.ids'), fixture('doors-rev-b.ids'), '--md'], 1],
  ['diff-broken', ['diff', fixture('doors-clean.ids'), fixture('broken.ids')], 2],
  ['diff-one-file', ['diff', fixture('doors-clean.ids')], 2],
  ['explain-text', ['explain', fixture('doors-rev-b.ids')], 0],
  ['explain-md-de', ['explain', fixture('doors-rev-b.ids'), '--md', '--lang', 'de'], 0],
  ['explain-bad-lang', ['explain', fixture('doors-rev-b.ids'), '--lang', 'xx'], 2],
  ['unknown-flag', ['audit', fixture('doors-clean.ids'), '--jsno'], 2],
  ['missing-file', ['audit', fixture('does-not-exist.ids')], 2],
];

describe('ifc-lite ids audit | lint | fmt | diff | explain', () => {
  it.each(CASES)('%s', async (name, args, exit) => {
    const r = await run(args);
    expect(r.exit, r.stderr).toBe(exit);
    await expect(golden(r)).toMatchFileSnapshot(`__golden__/ids/${name}.txt`);
  });
});

describe('ifc-lite ids fmt --write', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ids-fmt-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('rewrites the file to the canonical form, and a second pass changes nothing', async () => {
    const target = join(scratch, 'doors.ids');
    copyFileSync(fixture('doors-typo.ids'), target);
    expect((await run(['fmt', target, '--write'])).exit).toBe(0);
    const formatted = readFileSync(target, 'utf-8');
    expect(formatted).toBe((await run(['fmt', fixture('doors-typo.ids')])).stdout);
    const again = await run(['fmt', target, '--check']);
    expect(again.exit).toBe(0);
  });

  it('leaves a file it cannot write without loss untouched', async () => {
    const target = join(scratch, 'author.ids');
    copyFileSync(fixture('doors-author.ids'), target);
    expect((await run(['fmt', target, '--write'])).exit).toBe(2);
    expect(readFileSync(target, 'utf-8')).toBe(readFileSync(fixture('doors-author.ids'), 'utf-8'));
  });
});
