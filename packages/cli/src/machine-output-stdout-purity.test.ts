/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `docs/guide/cli.md` states the contract: **stdout = data**. A command that
 * emits `--json` (or, for `gym`, newline-delimited JSON) must put nothing else
 * there.
 *
 * It regressed because the parser and the wasm geometry module print through
 * `console.log`, which in Node IS stdout. Every command that drives geometry
 * must therefore call `routeConsoleDiagnosticsToStderr()` BEFORE the first
 * parse/geometry init -- the wasm module captures its print bindings at init
 * time, so a later call is too late. `clash` did; `simplify`, `lod`,
 * `extract-entities` and `gym` did not, and each emitted ~25 lines of
 * `[IFC-LITE] Opening classifier: …` ahead of its payload while still exiting 0.
 *
 * WHAT IS ASSERTED, and the three shapes that turned out to be vacuous.
 *
 * The redirect works by REPLACING `console.log`/`info`/`debug` with writers
 * that go to stderr. So the direct observable is: after the command has run,
 * this file's own `console.log` spy is no longer installed, and writing through
 * the console now reaches `process.stderr`. That is exactly what the production
 * change does, it needs no wasm and no build, and reverting the call flips it.
 *
 * What did NOT work, recorded so nobody re-walks it:
 *   1. Spawning `dist/index.js` and skipping when absent -- passes before and
 *      after the revert, because it never runs.
 *   2. Spawning `dist/index.js` as found on disk -- the revert oracle reverts
 *      SOURCE, and a `dist/` built beforehand still contains the fix.
 *   3. Rebuilding the package from `beforeAll` and spawning that -- observes
 *      the change locally, but shelling out to `tsc` from inside a test fights
 *      the oracle's own revert/restore, which reported REVERT-BROKE-BUILD.
 *
 * Asserting the payload itself is parseable needs a real binary plus a wasm
 * build that reaches the opening classifier, so it lives in the PR's manual
 * verification rather than here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Committed viewer demo sample, so this never needs `pnpm fixtures`.
const SAMPLE_IFC = resolve(__dirname, '../../../apps/viewer/public/samples/building-architecture.ifc');

/** A geometry pass on a real model is well past vitest's 5 s default. */
const CASE_TIMEOUT_MS = 300_000;

/** The console as it was before any test touched it. */
const PRISTINE = { log: console.log, info: console.info, debug: console.debug };

let outDir: string;
/** The spy this test installs; the command under test must displace it. */
let sentinel: (...parts: unknown[]) => void;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'ifc-lite-stdout-'));
  sentinel = () => {};
  console.log = sentinel;
  console.info = sentinel;
  console.debug = sentinel;
  // `routeConsoleDiagnosticsToStderr` latches at module scope and is
  // deliberately not restorable, so each case needs a fresh module registry
  // for the command to call through rather than return early.
  vi.resetModules();
});

afterEach(() => {
  console.log = PRISTINE.log;
  console.info = PRISTINE.info;
  console.debug = PRISTINE.debug;
  rmSync(outDir, { recursive: true, force: true });
});

/**
 * Did the command redirect the console before returning, and does writing
 * through it now reach stderr rather than stdout?
 */
function expectConsoleRoutedToStderr(label: string) {
  expect(console.log, `${label} never redirected console.log`).not.toBe(sentinel);

  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  });
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  try {
    console.log('[IFC-LITE] a diagnostic the wasm module would print');
  } finally {
    errSpy.mockRestore();
    outSpy.mockRestore();
  }

  expect(stderrChunks.join(''), `${label} did not send diagnostics to stderr`).toContain('[IFC-LITE]');
  expect(stdoutChunks.join(''), `${label} leaked a diagnostic onto stdout`).toBe('');
}

describe('commands that emit machine-readable stdout redirect console diagnostics', () => {
  it('simplify --json', async () => {
    const { simplifyCommand } = await import('./commands/simplify.js');
    await simplifyCommand([SAMPLE_IFC, '--out', join(outDir, 's.ifc'), '--level', '3', '--json']);
    expectConsoleRoutedToStderr('simplify');
  }, CASE_TIMEOUT_MS);

  it('lod --json', async () => {
    const { lodCommand } = await import('./commands/lod.js');
    await lodCommand([SAMPLE_IFC, '--level', '1', '--out', join(outDir, 'm.glb'), '--json']);
    expectConsoleRoutedToStderr('lod');
  }, CASE_TIMEOUT_MS);

  it('extract-entities --json', async () => {
    const { extractEntitiesCommand } = await import('./commands/extract-entities.js');
    await extractEntitiesCommand([SAMPLE_IFC, '--detect', '--report', '--json']);
    expectConsoleRoutedToStderr('extract-entities');
  }, CASE_TIMEOUT_MS);

  it('gym, whose whole protocol is NDJSON on stdout', async () => {
    const { gymCommand } = await import('./commands/gym.js');
    const emitted: string[] = [];
    const output = new (await import('node:stream')).PassThrough();
    output.on('data', (chunk: Buffer) => emitted.push(chunk.toString()));
    const input = Readable.from(['{"type":"close"}\n']) as unknown as NodeJS.ReadableStream;

    await gymCommand(['--model', SAMPLE_IFC, '--checks', 'schema,clash'], {
      output: output as unknown as NodeJS.WritableStream,
      input,
    });

    expectConsoleRoutedToStderr('gym');

    // And every line the consumer reads is a JSON object, as the protocol says.
    const lines = emitted.join('').split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line), `not JSON: ${line.slice(0, 80)}`).not.toThrow();
    }
  }, CASE_TIMEOUT_MS);
});
