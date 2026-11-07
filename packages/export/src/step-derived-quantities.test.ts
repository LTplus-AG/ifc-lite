/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A quantity set a view's base derives for an element created this session has
 * no edit behind it, and the exporter still has to write it (#9026 item 20).
 */

import { describe, expect, it } from 'vitest';
import { QuantityType, type QuantitySet } from '@ifc-lite/data';
import { IfcParser, extractQuantitiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

const WALL_ID = 8;
const SET = 'Qto_WallBaseQuantities';
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-08T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#8=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'Existing Wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

const parse = (text: string): Promise<IfcDataStore> => {
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
};
const derived = (value: number): QuantitySet[] => [{ name: SET, quantities: [{ name: 'Length', type: QuantityType.Length, value }] }];

interface Fixture { store: IfcDataStore; view: MutablePropertyView; overlayWall: number }

/** A view whose base answers for overlay ids the way the viewer's does. */
async function fixture(): Promise<Fixture> {
  const store = await parse(IFC);
  const view = new MutablePropertyView(null, 'm');
  view.setExpressIdWatermark(100);
  const overlayWall = view.createEntity('IfcWall', ['1OSuGGYUFyIf0LtE29OSuH', null, 'Authored', null, null, null, null, null, null]).expressId;
  view.setQuantityExtractor((id, asking, occurrence) => (asking.getNewEntity(id) ? derived(occurrence) : []));
  return { store, view, overlayWall };
}

const exported = (f: Fixture, options: Parameters<StepExporter['export']>[0] = { schema: 'IFC4', applyMutations: true }): string =>
  new TextDecoder().decode(new StepExporter(f.store, f.view).export(options).content);

describe('sets a view base derives for an overlay-created element', () => {
  it('reach the file with no edit naming them', async () => {
    const f = await fixture();
    const reopened = await parse(exported(f));
    expect(extractQuantitiesOnDemand(reopened, f.overlayWall)).toMatchObject([{ name: SET, quantities: [{ name: 'Length', value: f.overlayWall }] }]);
  });

  it('do not reach the file when the caller excludes quantities', async () => {
    const f = await fixture();
    expect(exported(f, { schema: 'IFC4', applyMutations: true, includeQuantities: false })).not.toContain(SET);
  });

  it('do not reach the file when the set was deleted', async () => {
    const f = await fixture();
    f.view.deleteQuantitySet(f.overlayWall, SET);
    expect(exported(f)).not.toContain(SET);
  });

  it('take a person\'s edit in place of the derived value', async () => {
    const f = await fixture();
    f.view.setQuantity(f.overlayWall, SET, 'Length', 7);
    const reopened = await parse(exported(f));
    expect(extractQuantitiesOnDemand(reopened, f.overlayWall)[0].quantities[0].value).toBe(7);
  });

  it('are not nominated for a loaded element or for a copy of one', async () => {
    const f = await fixture();
    f.view.setEntityAlias(f.overlayWall, WALL_ID);
    expect(exported(f)).not.toContain(SET);
  });
});
