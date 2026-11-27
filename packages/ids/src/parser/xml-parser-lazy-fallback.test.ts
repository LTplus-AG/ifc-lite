/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment node

import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// workerd reports `process.versions.node` but cannot resolve `@xmldom/xmldom`, so importing must not load it (#10961).
// The loader reaches xmldom through createRequire, which vi.mock does not see; the CJS require cache does.
const require = createRequire(import.meta.url);
const xmldomEntry = require.resolve('@xmldom/xmldom');

const MINIMAL_IDS = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Lazy fallback</title></info>
  <specifications>
    <specification name="Walls" ifcVersion="IFC4">
      <applicability><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
    </specification>
  </specifications>
</ids>`;

describe('parseIDS xmldom fallback (#10961)', () => {
  it('does not load @xmldom/xmldom when the module is imported', async () => {
    expect('DOMParser' in globalThis).toBe(false);
    delete require.cache[xmldomEntry];
    vi.resetModules();
    await import('./xml-parser.js');
    expect(require.cache[xmldomEntry]).toBeUndefined();
  });

  it('loads it on the first parse on Node without a global DOMParser', async () => {
    const { parseIDS } = await import('./xml-parser.js');
    const doc = parseIDS(MINIMAL_IDS);
    expect(doc.info.title).toBe('Lazy fallback');
    expect(doc.specifications).toHaveLength(1);
    expect(require.cache[xmldomEntry]).toBeDefined();
  });
});
