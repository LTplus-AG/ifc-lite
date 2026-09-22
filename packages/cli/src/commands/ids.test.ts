/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite ids --json` exit-code contract.
 *
 * The human-readable path has always set `process.exitCode` from
 * `summary.failedSpecifications` so a CI step piping through this command
 * fails when the model fails IDS validation. The `--json` path returned
 * right after `printJson(...)` without ever touching `process.exitCode` --
 * a script driving this command with `--json` (the shape any script would
 * actually parse) saw a clean exit 0 even when every specification failed.
 * Proven by direct invocation: `ifc-lite ids <fail-fixture> --json` exited 0
 * while the same fixture without `--json` exited 1.
 */

import { describe, expect, it, vi, afterEach, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { idsCommand } from './ids.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = resolve(here, '../../../ids/src/__corpus__/buildingsmart-ids/classification');
const FAIL_IFC = resolve(corpus, 'fail-systems_should_match_exactly_2_5.ifc');
const FAIL_IDS = resolve(corpus, 'fail-systems_should_match_exactly_2_5.ids');
const PASS_IFC = resolve(corpus, 'pass-systems_should_match_exactly_1_5.ifc');
const PASS_IDS = resolve(corpus, 'pass-systems_should_match_exactly_1_5.ids');

function silenceOutput() {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

function capturedStdout(): string[] {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return chunks;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// Fixtures for the zero-specification and not-applicable cases, written to a
// scratch dir since the corpus only carries genuine pass/fail rulesets.
const scratchDir = mkdtempSync(join(tmpdir(), 'ids-cli-test-'));

const ZERO_SPEC_IDS = join(scratchDir, 'zero-spec.ids');
writeFileSync(
  ZERO_SPEC_IDS,
  `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd" xmlns="http://standards.buildingsmart.org/IDS">
  <info>
    <title>Zero specifications</title>
  </info>
  <specifications>
  </specifications>
</ids>
`
);

// Applicability matches an entity type absent from PASS_IFC (which has
// IFCPROJECT/IFCWALL/IFCSLAB/IFCCOLUMN/IFCBEAM but no IFCDOOR), so the one
// specification here is legitimately not-applicable -- distinct from the
// zero-specification case above. `minOccurs="0"` marks the applicability as
// optional; without it the parser defaults minOccurs to 1 (REQUIRED), which
// would make zero matches a cardinality failure rather than a vacuous pass.
const NOT_APPLICABLE_IDS = join(scratchDir, 'not-applicable.ids');
writeFileSync(
  NOT_APPLICABLE_IDS,
  `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd" xmlns="http://standards.buildingsmart.org/IDS">
  <info>
    <title>Not applicable</title>
  </info>
  <specifications>
    <specification name="No doors here" ifcVersion="IFC2X3 IFC4">
      <applicability minOccurs="0" maxOccurs="unbounded">
        <entity>
          <name>
            <simpleValue>IFCDOOR</simpleValue>
          </name>
        </entity>
      </applicability>
      <requirements>
        <classification>
          <system>
            <simpleValue>Foobar</simpleValue>
          </system>
        </classification>
      </requirements>
    </specification>
  </specifications>
</ids>
`
);

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe('idsCommand --json exit code', () => {
  it('sets a non-zero exit code when the JSON report contains a failed specification', async () => {
    silenceOutput();
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      await idsCommand([FAIL_IFC, FAIL_IDS, '--json']);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('leaves the exit code at 0 for a fully passing --json run', async () => {
    silenceOutput();
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      await idsCommand([PASS_IFC, PASS_IDS, '--json']);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('agrees with the non-JSON path on the same failing input', async () => {
    silenceOutput();
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      await idsCommand([FAIL_IFC, FAIL_IDS]);
      const humanExit = process.exitCode;

      process.exitCode = 0;
      await idsCommand([FAIL_IFC, FAIL_IDS, '--json']);
      const jsonExit = process.exitCode;

      expect(jsonExit).toBe(humanExit);
      expect(jsonExit).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

describe('idsCommand zero-specification ruleset (#5190)', () => {
  it('human path: exits non-zero with a message distinguishing an empty ruleset from a failure', async () => {
    const chunks = capturedStdout();
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      await idsCommand([PASS_IFC, ZERO_SPEC_IDS]);
      expect(process.exitCode).not.toBe(0);
      const out = chunks.join('');
      expect(out).toContain('declares zero specifications');
      expect(out).not.toContain('Result: PASS');
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('--json path: exits non-zero and carries a machine-readable error field', async () => {
    const chunks = capturedStdout();
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      await idsCommand([PASS_IFC, ZERO_SPEC_IDS, '--json']);
      expect(process.exitCode).not.toBe(0);
      const parsed = JSON.parse(chunks.join(''));
      expect(parsed.error).toBe('declares zero specifications');
      expect(parsed.summary.totalSpecifications).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('no-regression pin: a ruleset whose specifications all pass still exits 0', async () => {
    silenceOutput();
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      await idsCommand([PASS_IFC, PASS_IDS]);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('no-regression pin: specifications that exist but match no entities (not-applicable) still exit 0', async () => {
    const chunks = capturedStdout();
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      await idsCommand([PASS_IFC, NOT_APPLICABLE_IDS]);
      expect(process.exitCode).toBe(0);
      expect(chunks.join('')).toContain('Result: PASS');
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
