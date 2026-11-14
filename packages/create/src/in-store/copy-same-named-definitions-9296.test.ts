/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it, expect } from 'vitest';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, recordCompoundMutation, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { copyBatchInStore } from './copy-batch.js';

// #9296: the #40/#71 Custom_B graph from the shared-set export regression,
// with a simple placement so the wall also exercises the real copy path.
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('same-named-copy.ifc','',(''),(''),'test','test','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,#9);
#9=IFCUNITASSIGNMENT((#10));
#10=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCWALL('2Z2BGIG3j5fRzbeoRb82L1',$,'Wall A',$,$,#100,$,$,$);
#21=IFCWALL('2Z2BGIG3j5fRzbeoRb82L2',$,'Wall B',$,$,#100,$,$,$);
#22=IFCWALL('2Z2BGIG3j5fRzbeoRb82L3',$,'Wall C',$,$,#100,$,$,$);
#30=IFCPROPERTYSINGLEVALUE('B1',$,IFCLABEL('b1'),$);
#31=IFCPROPERTYLISTVALUE('Layers',$,(IFCLABEL('p'),IFCLABEL('q')),$);
#32=IFCPROPERTYENUMERATION('FireClassEnum',(IFCLABEL('A'),IFCLABEL('B')),$);
#33=IFCPROPERTYENUMERATEDVALUE('FireClass',$,(IFCLABEL('A')),#32);
#34=IFCPROPERTYBOUNDEDVALUE('Range',$,IFCREAL(2.),IFCREAL(1.),$,$);
#35=IFCPROPERTYTABLEVALUE('Curve',$,(IFCREAL(1.),IFCREAL(2.)),(IFCREAL(10.),IFCREAL(20.)),$,$,$,$);
#36=IFCPROPERTYSINGLEVALUE('C1',$,IFCLABEL('c1'),$);
#37=IFCCOMPLEXPROPERTY('Nested',$,'Usage',(#36));
#38=IFCPROPERTYREFERENCEVALUE('Doc',$,$,#39);
#39=IFCDOCUMENTREFERENCE($,$,'Spec',$,$);
#40=IFCPROPERTYSET('3wkd_mjInDCfOthy7w_A60',$,'Custom_B',$,(#30,#31,#33,#34,#35,#37,#38));
#41=IFCRELDEFINESBYPROPERTIES('0x8Q_7Can5hOwBoiPhy1M1',$,$,$,(#20,#21,#22),#40);
#70=IFCPROPERTYSINGLEVALUE('B1',$,IFCLABEL('second'),$);
#71=IFCPROPERTYSET('1yqM3I0Wn6ah7BCQg6Cf_V',$,'Custom_B',$,(#70));
#72=IFCRELDEFINESBYPROPERTIES('0x8Q_7Can5hOwBoiPhy1M3',$,$,$,(#20),#71);
#100=IFCLOCALPLACEMENT($,#101);
#101=IFCAXIS2PLACEMENT3D(#102,$,$);
#102=IFCCARTESIANPOINT((0.,0.,0.));
ENDSEC;
END-ISO-10303-21;`;

it('#9296 copying edited #40 retains distinct same-named #71 and untouched shared owners', async () => {
  const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  const store = await parse(new TextEncoder().encode(IFC)), view = new MutablePropertyView(null, 'copy');
  view.setOnDemandExtractor(id => extractPropertiesOnDemand(store, id));
  view.setProperty(20, 'Custom_B', 'B1', 'edited');
  const save = () => new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
  const sets = (data: typeof store, id: number) => extractPropertiesOnDemand(data, id).filter(set => set.name === 'Custom_B');
  const history = view.getMutationCount();
  const copy = recordCompoundMutation(view, draft => copyBatchInStore(store, new StoreEditor(store, draft),
    [20], [{ offset: [0, 3, 0] }])[0].copyId);
  const reopened = await parse(save());
  expect(sets(reopened, copy)).toHaveLength(2);
  expect(sets(reopened, copy).map(set => set.properties.find(member => member.name === 'B1')?.value)).toEqual(['edited', 'second']);
  expect(sets(reopened, copy).map(set => set.properties)).toEqual(sets(reopened, 20).map(set => set.properties));
  for (const id of [21, 22]) {
    expect(sets(reopened, id)).toHaveLength(1);
    expect(sets(reopened, id)[0].properties).toEqual(sets(store, id)[0].properties);
  }
  undoRecordedMutationOperations(view, 1, () => { throw new Error('The copy must undo as one operation'); });
  expect(view.getMutationCount()).toBe(history);
  const undone = await parse(save());
  expect(undone.entities.getTypeName(copy)).toBe('Unknown');
  expect(sets(undone, 20).map(set => set.properties)).toEqual(sets(reopened, 20).map(set => set.properties));
});
