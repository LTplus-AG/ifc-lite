/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { tableFromIPC } from 'apache-arrow';
import { readParquet } from 'parquet-wasm';
import { ParquetExporter } from './parquet-exporter.js';

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('m','2026',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);
#2=IFCBUILDING('0000000000000000000002',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#3=IFCWALL('0000000000000000000003',$,'Old',$,$,$,$,$,$);
#4=IFCWALL('0000000000000000000004',$,'New',$,$,$,$,$,$);
#5=IFCRELAGGREGATES('0000000000000000000005',$,$,$,#2,(#3));
ENDSEC;END-ISO-10303-21;`;

async function fixture() {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer as ArrayBuffer);
  const view = new MutablePropertyView(null, 'm1');
  view.setExpressIdWatermark(5);
  const exporter = new ParquetExporter(store, undefined, view);
  const rows = async () => tableFromIPC(readParquet(await exporter.exportTable('relationships')).intoIPCStream())
    .toArray().map(row => row.toJSON());
  return { view, rows };
}

describe('Parquet effective relationship rows (#5249)', () => {
  it('replaces parsed endpoints with the current positional edit on the same exporter', async () => {
    const { view, rows } = await fixture();
    expect(await rows()).toEqual([{
      SourceId: 2, TargetId: 3, RelType: 'IfcRelAggregates', RelId: 5,
    }]);

    view.setPositionalAttribute(5, 5, ['#4'], true);
    expect(await rows()).toEqual([{
      SourceId: 2, TargetId: 4, RelType: 'IfcRelAggregates', RelId: 5,
    }]);
  });

  it('includes live created records and applies their edits and tombstones', async () => {
    const { view, rows } = await fixture();
    const relation = view.createEntity('IfcRelAggregates', [
      '0000000000000000000006', null, null, null, '#2', ['#3'],
    ]);
    view.setAttribute(relation.expressId, 'RelatedObjects', '#4');

    expect(await rows()).toEqual([
      { SourceId: 2, TargetId: 3, RelType: 'IfcRelAggregates', RelId: 5 },
      { SourceId: 2, TargetId: 4, RelType: 'IfcRelAggregates', RelId: relation.expressId },
    ]);

    view.deleteEntity(4);
    expect(await rows()).toEqual([
      { SourceId: 2, TargetId: 3, RelType: 'IfcRelAggregates', RelId: 5 },
    ]);
  });

  it('uses the effective relationship class after a retype', async () => {
    const { view, rows } = await fixture();
    view.setEntityType(5, 'IfcRelNests');
    expect(await rows()).toEqual([{
      SourceId: 2, TargetId: 3, RelType: 'IfcRelNests', RelId: 5,
    }]);
  });
});
