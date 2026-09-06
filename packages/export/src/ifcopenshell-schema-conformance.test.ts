/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema-conformance check for the STEP/IFC writer, against IfcOpenShell (#4043).
 *
 * Every other fidelity test for this writer — `step-roundtrip.test.ts`,
 * `step-exporter.test.ts`, `schema-converter.test.ts` — is
 * `parse(write(x))` through `@ifc-lite/parser`, our own code reading its own
 * output. That is blind by construction to a mandatory STEP/EXPRESS
 * attribute our tolerant parser accepts but a strict engine rejects — the
 * exact shape of regression #1839 (a WHOLE number serialized into a
 * REAL-backed positional slot), which was only caught because someone ran
 * `ifcopenshell.validate` by hand once and never wired it in.
 *
 * This test re-exports two real third-party fixtures through `StepExporter`
 * and shells out to `tools/ifcopenshell_reference/validate_export.py`, which
 * runs `ifcopenshell.validate.validate(file, logger, express_rules=True)` —
 * an external authority this codebase does not control. The two ORIGINAL
 * fixtures are validated too, as a control: if a fixture were itself
 * non-conformant, a real defect in ifc-lite's writer could hide behind it
 * (or an already-non-conformant input could be mistaken for a writer
 * defect). See `validate_export.py`'s own header for the vacuous-pass
 * refusals (zero files / missing file / ifcopenshell unavailable all fail,
 * never silently pass) and `test_validate_export.py` for the fault-injection
 * proof that the check itself has teeth.
 *
 * Requires a Python environment with `ifcopenshell` installed (see
 * `tools/ifcopenshell_reference/requirements.lock`, plus `pytest` for
 * `ifcopenshell.express.rule_executor`) — set `IFCOPENSHELL_PYTHON` to point
 * at it, or have it on `python3`. Wired in CI by
 * `.github/workflows/export-schema-conformance.yml`, gated on
 * `packages/export/**` changes so it doesn't run on every PR (see that
 * workflow's own header for the cost tradeoff). Locally, without that
 * environment, this SKIPS loudly (vitest reports it as skipped, not
 * passed) rather than passing vacuously.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { IfcParser } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';

const MODELS_DIR = resolve(__dirname, '../../../tests/models');
const TOOL_DIR = resolve(__dirname, '../../../tools/ifcopenshell_reference');
const VALIDATE_SCRIPT = resolve(TOOL_DIR, 'validate_export.py');

const FIXTURES = ['ara3d/duplex.ifc', 'ara3d/IfcOpenHouse_IFC4.ifc'];

const PYTHON = process.env.IFCOPENSHELL_PYTHON || 'python3';

function fixturesAvailable(): boolean {
  return FIXTURES.every((f) => existsSync(resolve(MODELS_DIR, f)));
}

function ifcopenshellAvailable(): boolean {
  const result = spawnSync(PYTHON, ['-c', 'import ifcopenshell, ifcopenshell.validate'], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function reExport(name: string, outDir: string): Promise<string> {
  const parser = new IfcParser();
  const store = await parser.parseColumnar(toArrayBuffer(readFileSync(resolve(MODELS_DIR, name))));
  const result = new StepExporter(store).export({ schema: store.schemaVersion });
  const outPath = join(outDir, name.replace(/\//g, '__'));
  writeFileSync(outPath, Buffer.from(result.content));
  return outPath;
}

const canRun = fixturesAvailable() && ifcopenshellAvailable();
if (!canRun) {
  console.warn(
    '[ifcopenshell-schema-conformance] SKIPPED: ' +
      (!fixturesAvailable()
        ? 'fixtures missing — run `pnpm fixtures`.'
        : `ifcopenshell not importable via "${PYTHON}" — set IFCOPENSHELL_PYTHON or install ` +
          'tools/ifcopenshell_reference/requirements.lock (+ pytest).'),
  );
}

// Each test below shells out to a cold Python process that imports
// ifcopenshell.validate (which in turn imports ifcopenshell.express's
// rule_executor, and through it pytest's assertion rewriter — see
// validate_export.py's header) before it can check a single entity. That
// import chain, plus running express_rules=True over two real fixtures, is
// consistently 3-4s locally and measured at 7.5-7.6s on GitHub's shared
// runners — comfortably over vitest's 5000ms default. It is not repeated
// or wasted work (each test validates a different input: the original
// fixtures as a control vs. this branch's StepExporter re-export), so the
// fix is a longer timeout on these two tests specifically, not a smaller
// one elsewhere.
const IFCOPENSHELL_TEST_TIMEOUT_MS = 20_000;

describe.skipIf(!canRun)('StepExporter output is schema-conformant per IfcOpenShell', () => {
  it(
    'validates the ORIGINAL fixtures as a control (a non-conformant input must not masquerade as a writer defect)',
    () => {
      const inputs = FIXTURES.map((f) => resolve(MODELS_DIR, f));
      expect(inputs.length).toBeGreaterThan(0);
      runValidateOrThrow(inputs);
    },
    IFCOPENSHELL_TEST_TIMEOUT_MS,
  );

  it(
    'validates the full-fidelity StepExporter re-export of both fixtures',
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'ifc-lite-export-conformance-'));
      const outputs: string[] = [];
      for (const fixture of FIXTURES) {
        outputs.push(await reExport(fixture, outDir));
      }
      expect(outputs.length).toBe(FIXTURES.length);
      runValidateOrThrow(outputs);
    },
    IFCOPENSHELL_TEST_TIMEOUT_MS,
  );
});

/**
 * Runs validate_export.py and turns a failure into a vitest assertion that
 * carries the script's own stdout — the offending entity and rule — rather
 * than a bare non-zero exit code.
 */
function runValidateOrThrow(files: string[]): void {
  expect(files.length, 'refuse to validate zero files').toBeGreaterThan(0);
  try {
    const stdout = execFileSync(PYTHON, [VALIDATE_SCRIPT, ...files], { encoding: 'utf8' });
    expect(stdout).toContain('0 issues');
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `ifcopenshell schema-conformance check failed:\n${e.stdout ?? ''}\n${e.stderr ?? e.message ?? ''}`,
    );
  }
}
