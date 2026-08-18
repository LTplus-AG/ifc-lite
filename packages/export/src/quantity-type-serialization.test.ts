/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The structural twin of `property-value-serialization.test.ts`, filed as part
 * of github.com/LTplus-AG/ifc-lite/issues/2765.
 *
 * `StoreEditor.addPropertySet`'s TEXT/LABEL map is pinned by that file, written
 * after the map got a member wrong. `addQuantitySet`'s kind map is the same
 * shape of table one method down and nothing pinned it: swapping
 * `AREA: QuantityType.Volume, VOLUME: QuantityType.Area` left 251 tests green
 * across `mutations`, `create` and `export`.
 *
 * It stayed invisible because every existing caller asserts the numeric VALUE
 * and never the entity token that declares what the number MEANS. `12.5` is
 * `12.5` whether it is written as `IFCQUANTITYAREA` or `IFCQUANTITYVOLUME`, so
 * a miswiring would have exported every area as a volume with no test
 * disagreeing anywhere. The token is the discriminating output, so the whole
 * table is asserted here, from the authoring API through to the file.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';

/**
 * Derived from the authoring API rather than imported: `QuantityKind` is not
 * part of the package's public surface, and widening that surface for a test
 * is the wrong trade. Deriving it keeps the table below tied to the real
 * union, so adding a kind to the API makes this list incomplete at compile
 * time rather than silently under-covering.
 */
type QuantityKind = Parameters<StoreEditor['addQuantitySet']>[2][number]['quantityType'];
import { StepExporter } from './step-exporter.js';

const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-18T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#8=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'Existing Wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

const WALL_ID = 8;

async function parseBase(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(BASE_IFC);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

/** Author one quantity of `kind` and return the exported STEP text. */
async function exportOneQuantity(kind: QuantityKind, name: string): Promise<string> {
  const store = await parseBase();
  const view = new MutablePropertyView(null, 'test-model');
  const editor = new StoreEditor(store, view);
  editor.addQuantitySet(WALL_ID, 'Qto_Authored', [{ name, value: 12.5, quantityType: kind }]);
  const result = new StepExporter(store, view).export({ schema: 'IFC4' });
  return new TextDecoder().decode(result.content);
}

describe('every QuantityKind is exported as the IFC quantity entity it was authored as', () => {
  /** The whole table. A kind missing from this list is a kind nothing pins. */
  const CASES: Array<[kind: QuantityKind, token: string]> = [
    ['LENGTH', 'IFCQUANTITYLENGTH'],
    ['AREA', 'IFCQUANTITYAREA'],
    ['VOLUME', 'IFCQUANTITYVOLUME'],
    ['COUNT', 'IFCQUANTITYCOUNT'],
    ['WEIGHT', 'IFCQUANTITYWEIGHT'],
    ['TIME', 'IFCQUANTITYTIME'],
  ];

  for (const [kind, token] of CASES) {
    it(`${kind} is written as ${token}`, async () => {
      const text = await exportOneQuantity(kind, 'Q');
      expect(text).toContain(`=${token}('Q',`);
    });
  }

  it('does not write an area as a volume, or a volume as an area', async () => {
    // The pair the issue named, asserted against each other rather than only
    // for presence: a swapped map satisfies "an IFCQUANTITY* was written" and
    // "the value is 12.5" at the same time.
    const area = await exportOneQuantity('AREA', 'GrossArea');
    expect(area).toContain("=IFCQUANTITYAREA('GrossArea',");
    expect(area).not.toContain("=IFCQUANTITYVOLUME('GrossArea',");

    const volume = await exportOneQuantity('VOLUME', 'GrossVolume');
    expect(volume).toContain("=IFCQUANTITYVOLUME('GrossVolume',");
    expect(volume).not.toContain("=IFCQUANTITYAREA('GrossVolume',");
  });

  it('carries the value too, which is all the existing callers ever checked', async () => {
    // The control that shows why the assertions above are the ones that matter:
    // this line passes with the map swapped.
    const text = await exportOneQuantity('AREA', 'GrossArea');
    expect(text).toContain('12.5');
  });
});
