/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A truncated IFC file does not fail to parse: it parses to a PREFIX.
 *
 * The scan stops wherever the bytes stop and reports whatever it reached, so
 * the loader's only check -- `ISO-10303-21` somewhere in the first 256 bytes --
 * let both of these through with exit 0 (#5532):
 *
 *   - the first 4 KB of a real model  -> "Entities: 59"
 *   - a 22-byte `ISO-10303-21;\nHEADER;\n` stub, with no FILE_SCHEMA at all
 *     -> "Schema: IFC4", from `detectSchemaVersion`'s documented last-resort
 *     default
 *
 * A confidently wrong answer is worse than an error here, because nothing
 * downstream can tell "59 entities" from a genuinely small model.
 *
 * These cases assert the REJECTION and, just as importantly, that well-formed
 * files still load -- a terminator check that is too strict would reject real
 * exports, which is the failure mode worth guarding against.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIfcFile } from './loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Committed viewer sample, so this never needs `pnpm fixtures`. */
const REAL_MODEL = resolve(__dirname, '../../../apps/viewer/public/samples/hello-wall.ifc');

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run `loadModel` over `content`; return stderr, or null if it succeeded. */
async function rejectionFor(content: string | Uint8Array): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), 'ifc-lite-loader-'));
  const file = join(dir, 'model.ifc');
  writeFileSync(file, content);

  const stderr: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });

  try {
    await loadIfcFile(file);
    return null;
  } catch {
    // `process.exit` is turned into a throw by the test runner.
    return stderr.join('');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('a truncated STEP file is refused, not summarised', () => {
  it('rejects the leading bytes of a real model', async () => {
    const prefix = readFileSync(REAL_MODEL).subarray(0, 4000);
    const stderr = await rejectionFor(prefix);
    expect(stderr, 'a truncated model was accepted').not.toBeNull();
    expect(stderr).toMatch(/truncated/);
    expect(stderr).toMatch(/END-ISO-10303-21/);
  });

  it('rejects a header-only stub rather than inventing a schema', async () => {
    const stderr = await rejectionFor('ISO-10303-21;\nHEADER;\n');
    expect(stderr, 'a 22-byte stub was accepted').not.toBeNull();
    expect(stderr).toMatch(/truncated/);
  });
});

describe('a complete file with no entities is refused too', () => {
  it('rejects a well-terminated file that has no DATA section', async () => {
    const stderr = await rejectionFor(
      "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nEND-ISO-10303-21;\n",
    );
    expect(stderr).toMatch(/no DATA section/);
  });
});

describe('well-formed files still load', () => {
  it('accepts the committed sample unchanged', async () => {
    const store = await loadIfcFile(REAL_MODEL);
    expect(store.entityCount).toBeGreaterThan(0);
  });

  it('accepts a file whose terminator is followed by trailing whitespace', async () => {
    const withTrailer = `${readFileSync(REAL_MODEL, 'latin1')}\n\n`;
    expect(await rejectionFor(withTrailer)).toBeNull();
  });
});
