/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The single-wall fixture from issue #6117: three property-facet
 * behaviours where `@ifc-lite/ids` 3.0.3 disagreed with upstream
 * ifctester (IfcOpenShell 0.8.5). `wall.ifc` reproduces the reporter's
 * STEP lines (#2-#7 in the issue) verbatim, one requirement per `.ids`
 * file, mirroring how the reporter tested it.
 *
 * Each case here failed on `main` before the fix (see the issue and PR
 * for the exact before/after verdicts) and is pinned to the ifctester
 * verdict from the issue's table. Case 3 (empty value under
 * `optional`/`prohibited`) reflects the ifctester reading, not a
 * buildingSMART IDS 1.0 corpus case — the corpus only covers the
 * REQUIRED case
 * (`../buildingsmart-ids/property/fail-an_empty_string_is_considered_false_and_will_not_pass.ids`),
 * which both engines already agreed on and which stays a `fail` here
 * (see `empty-required.ids` below).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS } from '../../parser/xml-parser.js';
import { validateIDS } from '../../validation/validator.js';
import { createDataAccessor } from '../../bridge/index.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const WALL_IFC = join(DIR, 'wall.ifc');

async function verdictFor(idsFile: string): Promise<string> {
  const document = parseIDS(readFileSync(join(DIR, idsFile), 'utf8'));
  const bytes = readFileSync(WALL_IFC);
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  );
  const accessor = createDataAccessor(store);
  const report = await validateIDS(document, accessor, {
    modelId: idsFile,
    schemaVersion: String(store.schemaVersion ?? 'IFC4'),
    entityCount: 0,
  });
  expect(report.specificationResults).toHaveLength(1);
  return report.specificationResults[0]!.status;
}

describe('ifctester property-facet parity (#6117)', () => {
  it('case 1: an IfcLabel numeric-looking value ("1.0000001") does not match "1" within the 1e-6 tolerance', async () => {
    // ifctester: fail. Before the fix, `matchSimpleValue` fell back to
    // `compareNumeric` for any two numeric-looking strings regardless of
    // declared type, so this passed incorrectly.
    expect(await verdictFor('numeric-tolerance.ids')).toBe('fail');
  });

  it('case 2: a baseName simpleValue with a leading space (" Spaced") matches the untrimmed property name', async () => {
    // ifctester: pass. Before the fix, the parser trimmed `<simpleValue>`
    // text, so " Spaced" became "Spaced" and never matched the real
    // property name.
    expect(await verdictFor('spaced-property-name.ids')).toBe('pass');
  });

  it('case 3a: an empty IFCLABEL passes an optional property facet (treated as absent, per ifctester)', async () => {
    // ifctester: pass. Before the fix, `checkSingleProperty` failed an
    // empty value under every cardinality, including optional.
    expect(await verdictFor('empty-optional.ids')).toBe('pass');
  });

  it('case 3b: an empty IFCLABEL passes a prohibited property facet (already correct before the fix)', async () => {
    expect(await verdictFor('empty-prohibited.ids')).toBe('pass');
  });

  it('case 3c: an empty IFCLABEL still fails the default required cardinality (unchanged; both engines agree, per the corpus\'s fail-an_empty_string_is_considered_false_and_will_not_pass)', async () => {
    expect(await verdictFor('empty-required.ids')).toBe('fail');
  });
});
