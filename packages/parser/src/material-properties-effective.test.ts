/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { ColumnarParser } from './columnar-parser.js';
import { StepTokenizer } from './tokenizer.js';
import { extractMaterialPropertiesForMaterialId } from './on-demand-extractors.js';
import type { MaterialPropertiesView } from './on-demand-extractors.js';

async function parse(step: string) {
  const source = new TextEncoder().encode(step);
  const refs = [...new StepTokenizer(source).scanEntitiesFast()].map((ref) => ({
    expressId: ref.expressId,
    type: ref.type,
    byteOffset: ref.offset,
    byteLength: ref.length,
    lineNumber: ref.line,
  }));
  return new ColumnarParser().parseLite(source.buffer.slice(0), refs, {});
}

const prefix = `ISO-10303-21;HEADER;FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');FILE_NAME('test.ifc','2026-01-01T00:00:00',('a'),('a'),'','', '');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCMATERIAL('Concrete',$,$);
`;
const suffix = `ENDSEC;END-ISO-10303-21;`;

function view(
  newRows: Array<{ expressId: number; type: string; attributes: unknown[] }> = [],
  deleted = new Set<number>(),
  positional = new Map<number, Map<number, unknown>>(),
  named = new Map<number, Array<{ name: string; value: string }>>(),
): MaterialPropertiesView {
  const rows = new Map(newRows.map((row) => [row.expressId, row]));
  return {
    isDeleted: (id) => deleted.has(id),
    getNewEntities: () => newRows,
    getNewEntity: (id) => rows.get(id) ?? null,
    getPositionalMutationsForEntity: (id) => positional.get(id) ?? null,
    getAttributeMutationsForEntity: (id) => named.get(id) ?? [],
  };
}

describe('material-property reverse index uses effective entities (#5236)', () => {
  it('includes a session-created material-property row and its created simple property', async () => {
    const store = await parse(prefix + suffix);
    const result = extractMaterialPropertiesForMaterialId(store, 1, view([
      { expressId: 2, type: 'IFCMATERIALPROPERTIES', attributes: ['Live Pset', null, [3], 1] },
      { expressId: 3, type: 'IFCPROPERTYSINGLEVALUE', attributes: ['Density', null, ['IFCREAL', 2400], null] },
    ]));
    expect(result[0]?.psets).toEqual([
      { name: 'Live Pset', properties: [{ name: 'Density', type: 1, value: 2400, dataType: 'IFCREAL' }] },
    ]);
  });

  it('omits a tombstoned source material-property row', async () => {
    const store = await parse(prefix + `#2=IFCMATERIALPROPERTIES('Source Pset',$,(#3),#1);
#3=IFCPROPERTYSINGLEVALUE('Density',$,IFCREAL(2300.),$);
` + suffix);
    const result = extractMaterialPropertiesForMaterialId(store, 1, view([], new Set([2])));
    expect(result).toEqual([]);
  });

  it('reads live named and positional edits on source material properties', async () => {
    const store = await parse(prefix + `#2=IFCMATERIALPROPERTIES('Source Pset',$,(#3),#1);
#3=IFCPROPERTYSINGLEVALUE('Density',$,IFCREAL(2300.),$);
` + suffix);
    const result = extractMaterialPropertiesForMaterialId(store, 1, view([], new Set(),
      new Map([[3, new Map([[2, ['IFCREAL', 2550]]])]]),
      new Map([[2, [{ name: 'Name', value: 'Edited Pset' }]]]),
    ));
    expect(result[0]?.psets).toEqual([
      { name: 'Edited Pset', properties: [{ name: 'Density', type: 1, value: 2550, dataType: 'IFCREAL' }] },
    ]);
  });
});
