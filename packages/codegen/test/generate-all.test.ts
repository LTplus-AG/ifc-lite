/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression test: generateAll() must find both schema files it names.
 *
 * generateAll() hardcodes the schema filenames it looks for in the given
 * schemas directory. If a filename drifts out of sync with what actually
 * ships in schemas/, generateAll() does not throw or exit non-zero — it
 * just logs a warning and silently skips that schema's output directory.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateAll } from '../src/generator.js';

describe('generateAll', () => {
  let outDir: string | undefined;

  afterEach(() => {
    if (outDir) {
      rmSync(outDir, { recursive: true, force: true });
      outDir = undefined;
    }
  });

  it('generates output for every schema it names, not just the first', () => {
    outDir = mkdtempSync(join(tmpdir(), 'codegen-generate-all-'));
    const schemasDir = join(process.cwd(), 'schemas');

    generateAll(schemasDir, outDir);

    const produced = readdirSync(outDir);
    expect(produced).toContain('ifc4');
    expect(produced).toContain('ifc4x3');
    expect(existsSync(join(outDir, 'ifc4x3', 'entities.ts'))).toBe(true);
  });
});
