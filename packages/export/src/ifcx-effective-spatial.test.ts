/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcxWriter, type IfcxFile } from '@ifc-lite/ifcx';
import { getEffectiveEntityIndex } from './effective-index.js';
import { parquetRelationshipRows } from './parquet-relationship-rows.js';

const MODEL = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('spatial.ifc','2026',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);
#2=IFCBUILDINGSTOREY('0000000000000000000002',$,'A',$,$,$,$,$,.ELEMENT.,0.);
#3=IFCBUILDINGSTOREY('0000000000000000000003',$,'B',$,$,$,$,$,.ELEMENT.,3000.);
#4=IFCWALL('0000000000000000000004',$,'Wall',$,$,$,$,$);
#5=IFCRELAGGREGATES('0000000000000000000005',$,$,$,#1,(#2,#3));
#6=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000006',$,$,$,(#4),#2);
ENDSEC;END-ISO-10303-21;`;

describe('IFCX live spatial export from real IFC relationships (#5249)', () => {
  it('follows retargeted, deleted and newly authored containment in the same writer', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(MODEL).buffer as ArrayBuffer);
    const view = new MutablePropertyView(null, 'model');
    view.setExpressIdWatermark(6);
    const writer = new IfcxWriter({ entities: store.entities, strings: store.strings,
      spatialHierarchy: store.spatialHierarchy, mutationView: view });
    const exportLive = (): IfcxFile => {
      const rows = parquetRelationshipRows(store, view, getEffectiveEntityIndex(store, view, true));
      return JSON.parse(new IfcxWriter({ entities: store.entities, strings: store.strings,
        spatialHierarchy: store.spatialHierarchy, mutationView: view,
        effectiveSpatialEdges: rows.RelId.map((_, i) => ({
          sourceId: rows.SourceId[i], targetId: rows.TargetId[i], relationshipType: rows.RelType[i],
        })),
      }).export().content) as IfcxFile;
    };
    const children = (file: IfcxFile, id: number) => file.data.find(node => node.path === `000000000000000000000${id}`)?.children;

    expect(children(exportLive(), 2)).toEqual({ element_4: '0000000000000000000004' });
    view.setPositionalAttribute(6, 5, '#3', true);
    expect(() => writer.export()).toThrow(/needs effectiveSpatialEdges/);
    expect(children(exportLive(), 2)).toBeUndefined();
    expect(children(exportLive(), 3)).toEqual({ element_4: '0000000000000000000004' });

    view.deleteEntity(6);
    expect(children(exportLive(), 3)).toBeUndefined();
    view.createEntity('IfcRelContainedInSpatialStructure', [
      '0000000000000000000007', null, null, null, ['#4'], '#2',
    ]);
    expect(children(exportLive(), 2)).toEqual({ element_4: '0000000000000000000004' });
  });
});
