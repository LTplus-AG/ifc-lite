/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Parsed IFC with every Lists-only predicate mode represented (#6190): a
 * spatial tree down to a space, an aggregate with a property only on the
 * whole, quantities, a layered material, a classification and a type. Two
 * models: the second with a live mutation overlay, both with zone assignment
 * and zone volume results. */
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { zoneSetRevision, type ZoneAssignment, type ZoneSet } from '../../zones/index.js';
import type { ElementApportionment } from '../../zones/apportionment.js';
import { createListDataProvider, type ZoneListContext } from '../adapter.js';
import type { ModelProviderPair } from '../run-list.js';

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('t','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0Proj000000000000000001',$,'Tower',$,$,$,$,$,$);
#2=IFCSITE('0Site000000000000000002',$,'Site A',$,$,$,$,$,$,$,$,$,$,$);
#3=IFCBUILDING('0Bldg000000000000000003',$,'Building A',$,$,$,$,$,$,$,$,$);
#4=IFCBUILDINGSTOREY('0Stry000000000000000004',$,'Level 1',$,$,$,$,$,$,0.);
#5=IFCSPACE('0Spce000000000000000005',$,'Room 1',$,$,$,$,$,$,$,$);
#6=IFCRELAGGREGATES('0Agg0000000000000000006',$,$,$,#1,(#2));
#7=IFCRELAGGREGATES('0Agg0000000000000000007',$,$,$,#2,(#3));
#8=IFCRELAGGREGATES('0Agg0000000000000000008',$,$,$,#3,(#4));
#9=IFCRELAGGREGATES('0Agg0000000000000000009',$,$,$,#4,(#5));
#10=IFCWALL('0Wall000000000000000010',$,'Wall A',$,$,$,$,'T-10',$);
#20=IFCWALL('0Wall000000000000000020',$,'Wall B',$,$,$,$,$,$);
#30=IFCWALL('0Wall000000000000000030',$,'Part wall',$,$,$,$,$,$);
#35=IFCWALL('0Wall000000000000000035',$,'Loose wall',$,$,$,$,$,$);
#40=IFCELEMENTASSEMBLY('0Asm0000000000000000040',$,'Assembly',$,$,$,$,$,$,$);
#41=IFCRELAGGREGATES('0Agg0000000000000000041',$,$,$,#40,(#30));
#42=IFCPROPERTYSINGLEVALUE('Mark',$,IFCLABEL('ASM'),$);
#43=IFCPROPERTYSET('0Pset000000000000000043',$,'Pset_Assembly',$,(#42));
#44=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000044',$,$,$,(#40),#43);
#45=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Cnt000000000000000045',$,$,$,(#10,#40),#4);
#46=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Cnt000000000000000046',$,$,$,(#20),#5);
#50=IFCQUANTITYVOLUME('NetVolume',$,$,2.5,$);
#51=IFCELEMENTQUANTITY('0Qto0000000000000000051',$,'Qto_WallBaseQuantities',$,$,(#50));
#52=IFCRELDEFINESBYPROPERTIES('0Rel000000000000000052',$,$,$,(#10),#51);
#60=IFCMATERIAL('Concrete',$,'Structural');
#61=IFCMATERIALLAYER(#60,0.2,$,'Core',$,$,$);
#62=IFCMATERIALLAYERSET((#61),'Wall layers',$);
#63=IFCRELASSOCIATESMATERIAL('0Mat0000000000000000063',$,$,$,(#10),#62);
#64=IFCMATERIAL('Brick',$,$);
#65=IFCRELASSOCIATESMATERIAL('0Mat0000000000000000065',$,$,$,(#20),#64);
#70=IFCCLASSIFICATION('NBS',$,$,'Uniclass',$,$,$);
#71=IFCCLASSIFICATIONREFERENCE($,'Ss_25','Walls',#70,$,$);
#72=IFCRELASSOCIATESCLASSIFICATION('0Cls0000000000000000072',$,$,$,(#10),#71);
#80=IFCWALLTYPE('0Type00000000000000080',$,'WT-1',$,$,$,$,$,$,.NOTDEFINED.);
#81=IFCRELDEFINESBYTYPE('0Rel000000000000000081',$,$,$,(#10,#20),#80);
ENDSEC;
END-ISO-10303-21;`;

export const ZONE_SET: ZoneSet = {
  id: 'zs-sections', name: 'Sections', visible: true, createdAt: 0, updatedAt: 0,
  zones: [
    { id: 'z-a', name: 'Zone A', center: [0, 0, 0], size: [1, 1, 1], rotationY: 0 },
    { id: 'z-b', name: 'Zone B', center: [2, 0, 0], size: [1, 1, 1], rotationY: 0 },
  ],
};

const home = (zoneId: string | null, touched: string[] = zoneId ? [zoneId] : []): ZoneAssignment => ({
  zoneId, zoneName: ZONE_SET.zones.find((z) => z.id === zoneId)?.name ?? null,
  straddles: touched.length > 1, touchedZoneIds: touched,
});
const split = (shares: Array<[string, number]>): ElementApportionment => {
  const whole = shares.reduce((sum, [, v]) => sum + v, 0);
  return {
    wholeVolumeM3: whole, outsideVolumeM3: 0, outsideFraction: 0, overlapping: false,
    shares: shares.map(([zoneId, volumeM3]) => ({
      zoneId, zoneName: ZONE_SET.zones.find((z) => z.id === zoneId)!.name, volumeM3, fraction: volumeM3 / whole,
    })),
  } as ElementApportionment;
};

/** Zone data keyed by federated id, as the viewer's assignment sync stores it. */
function zoneContext(offset: number, assignments: Record<number, ZoneAssignment>, volumes: Record<number, ElementApportionment>): ZoneListContext {
  const key = (id: number) => id + offset;
  return {
    zoneSets: [ZONE_SET],
    zoneAssignments: new Map(Object.entries(assignments).map(([id, a]) => [key(Number(id)), { [ZONE_SET.id]: a }])),
    apportionment: new Map([[ZONE_SET.id, {
      revision: zoneSetRevision(ZONE_SET), computedAt: 0, elapsedMs: 0, refused: new Map(),
      byElement: new Map(Object.entries(volumes).map(([id, v]) => [key(Number(id)), v])),
    }]]),
    volumeSiScale: 1,
    getWorldPosition: (id) => ({ x: id, y: 0, z: 0 }),
    toGlobalId: key,
  };
}

async function parse() {
  const bytes = new TextEncoder().encode(IFC);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** Model 1 as loaded; model 2 a second parse with live edits and its own zone results. */
export async function models(): Promise<ModelProviderPair[]> {
  const first = await parse();
  const second = await parse();
  const view = new MutablePropertyView(second.properties, 'm2');
  view.setOnDemandExtractor((id) => extractPropertiesOnDemand(second, id));
  view.setAttribute(10, 'Name', 'Renamed wall');
  view.setProperty(35, 'Pset_Assembly', 'Mark', 'EDITED');
  view.setQuantity(35, 'Qto_WallBaseQuantities', 'NetVolume', 9);
  view.deleteEntity(20);
  return [
    { modelId: 'm1', store: first, provider: createListDataProvider(first, 'Model 1.ifc', zoneContext(0,
      { 10: home('z-a'), 20: home('z-a', ['z-a', 'z-b']), 30: home(null) },
      { 10: split([['z-a', 2]]), 20: split([['z-a', 1.5], ['z-b', 0.5]]) })) },
    { modelId: 'm2', store: second, mutationView: view, provider: createListDataProvider(second, 'Model 2.ifc', zoneContext(1_000_000,
      { 10: home('z-b'), 30: home('z-a', ['z-a', 'z-b']), 35: home('z-a') },
      { 30: split([['z-a', 0.4], ['z-b', 3]]), 35: split([['z-a', 5]]) }), view) },
  ];
}
