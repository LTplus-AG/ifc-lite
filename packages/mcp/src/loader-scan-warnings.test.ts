/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7610: the MCP loader silenced the parser's console during a load and passed
 * no onDiagnostic, so a model whose scan dropped a record (an unescaped
 * apostrophe, #7541) loaded with no sign it was short.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadIfcModel } from './loader.js';

const gid = (n: number) => String(n).padStart(22, '0');
function fileWith(name20: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'mcp-7610-')), 'model.ifc');
  writeFileSync(path, [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');", "FILE_NAME('a','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
    `#1=IFCPROJECT('${gid(1)}',$,'P',$,$,$,$,$,#3);`, '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#3=IFCUNITASSIGNMENT((#2));',
    `#20=IFCWALL('${gid(20)}',$,${name20},$,$,$,$,$,$);`, `#21=IFCWALL('${gid(21)}',$,'W2',$,$,$,$,$,$);`,
    'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n'));
  return path;
}

describe('an MCP model the scan read short says so (#7610)', () => {
  it('carries the dropped-record diagnostic on the loaded model', async () => {
    const loaded = await loadIfcModel(fileWith("'it's'"));
    expect(loaded.store.entityIndex.byId.has(20)).toBe(false);
    expect(loaded.scanWarnings).toHaveLength(1);
    expect(loaded.scanWarnings?.[0]).toMatch(/^scan: dropped a record with no terminating ';'/);
  });

  it('carries nothing for a model read in full', async () => {
    const loaded = await loadIfcModel(fileWith("'it''s'"));
    expect(loaded.store.entityIndex.byId.has(20)).toBe(true);
    expect(loaded.scanWarnings).toBeUndefined();
  });
});
