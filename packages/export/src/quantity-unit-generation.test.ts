/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';
import { getCompleteEntityIndex } from './entity-iteration.js';

it('#6232 generated quantities retain an existing resolvable metre unit through actual export and parser',async()=>{
  const bytes=await readFile(new URL('../../../apps/viewer/public/samples/hello-wall.ifc',import.meta.url));
  const store=await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),{disableWorkerScan:true});
  const reader=new EntityExtractor(store.source);
  const metre=store.entityIndex.byType.get('IFCSIUNIT')!.find(id=>String(reader.extractEntity(store.entityIndex.byId.get(id)!)!.attributes[1]).includes('LENGTHUNIT'))!;
  expect(metre).toBeGreaterThan(0);
  const view=new MutablePropertyView(null,'m'),editor=new StoreEditor(store,view);
  editor.addQuantitySet(1222,'Qto_UnitWitness',[{name:'WitnessLength',value:2.5,quantityType:'LENGTH',unit:'METRE'}]);
  const exported=new StepExporter(store,view).export({schema:'IFC4',applyMutations:true}).content;
  const parsed=await new IfcParser().parseColumnar(exported.slice().buffer as ArrayBuffer,{disableWorkerScan:true}),extractor=new EntityExtractor(parsed.source);
  const row=[...getCompleteEntityIndex(parsed)].map(([expressId, location])=>extractor.extractEntity({...location,expressId,lineNumber:0})!).find(entity=>entity.attributes[0]==='WitnessLength')!;
  expect(row.attributes[2]).toBe(metre);
  expect(row.attributes[3]).toBe(2.5);
  expect(extractor.extractEntity(parsed.entityIndex.byId.get(metre)!)!.attributes).toEqual(reader.extractEntity(store.entityIndex.byId.get(metre)!)!.attributes);
});
