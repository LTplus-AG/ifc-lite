/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcParser } from './index.js';
import { extractStructuralOnDemand, type StructuralExtractionView } from './structural-extractor.js';

const step = (schema: string, rows: string) => `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('reinforcement.ifc','',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));ENDSEC;DATA;${rows}ENDSEC;END-ISO-10303-21;`;
const area = "#15=IFCSURFACEREINFORCEMENTAREA('Reinforcement',(0.,0.002),(0.003,0.004,0.005),0.25);";
const parse = async (schema: string, rows: string) => new IfcParser().parseColumnar(
  new TextEncoder().encode(step(schema, rows)).buffer, { disableWorkerScan: true },
);

describe('surface reinforcement read model', () => {
  for (const schema of ['IFC4', 'IFC4X3']) {
    it(`reads standalone reinforcement and keeps list order and zero in ${schema}`, async () => {
      const result = extractStructuralOnDemand(await parse(schema, area));
      expect(result.hasStructural).toBe(true);
      expect(result.reinforcementAreas).toEqual([{
        expressId: 15, type: 'IfcSurfaceReinforcementArea', name: 'Reinforcement',
        SurfaceReinforcement1: [0, 0.002], SurfaceReinforcement2: [0.003, 0.004, 0.005],
        components: { ShearReinforcement: 0.25 },
      }]);
    });

    it(`reads reinforcement in a configuration without dropping or shifting its slot in ${schema}`, async () => {
      const store = await parse(schema, `${area}
        #16=IFCSTRUCTURALLOADSINGLEFORCE('Force',1.,$,$,$,$,$);
        #24=IFCSTRUCTURALLOADCONFIGURATION('Configuration',(#16,#15),((0.),(4.)));
        #50=IFCSTRUCTURALSURFACEACTION('0KQ0efL39PrP5DeqBwaUNp',$,'Action',$,$,$,$,#24,.GLOBAL_COORDS.,.F.,$,.CONST.);`);
      const result = extractStructuralOnDemand(store);
      const entries = result.activities[0].appliedLoad?.configuration?.entries;
      expect(entries?.map(e => [e.value?.expressId, e.location, e.dropped])).toEqual([
        [16, [0], undefined], [15, [4], undefined],
      ]);
      expect(entries?.[1].value).toEqual(result.reinforcementAreas?.[0]);
      expect(result.loadsTruncated).toBe(false);
    });

    it(`retains a reinforcement result whose source span is only in the deferred index in ${schema}`, async () => {
      const store = await parse(schema, `${area}
        #24=IFCSTRUCTURALLOADCONFIGURATION('Configuration',(#15),((4.)));
        #50=IFCSTRUCTURALSURFACEACTION('0KQ0efL39PrP5DeqBwaUNp',$,'Action',$,$,$,$,#24,.GLOBAL_COORDS.,.F.,$,.CONST.);`);
      const reference = store.entityIndex.byId.get(15)!;
      expect(store.entityIndex.byType.get('IFCSURFACEREINFORCEMENTAREA')).toContain(15);
      const deferred = {
        ...store,
        entityIndex: { ...store.entityIndex, byId: new Map([...store.entityIndex.byId.entries()].filter(([id]) => id !== 15)) },
        deferredEntityIndex: new Map([[15, reference]]),
      };
      const result = extractStructuralOnDemand(deferred);
      expect(result.hasStructural).toBe(true);
      expect(result.reinforcementAreas).toHaveLength(1);
      expect(result.reinforcementAreas?.[0].SurfaceReinforcement1).toEqual([0, 0.002]);
      const entry = result.activities[0].appliedLoad?.configuration?.entries[0];
      expect(entry?.value).toEqual(result.reinforcementAreas?.[0]);
      expect(entry?.dropped).toBeUndefined();
    });
  }

  it('keeps omitted reinforcement fields absent rather than reporting zeros or empty lists', async () => {
    const result = extractStructuralOnDemand(await parse('IFC4', "#15=IFCSURFACEREINFORCEMENTAREA($,$,$,0.);"));
    expect(result.reinforcementAreas?.[0]).toEqual({
      expressId: 15, type: 'IfcSurfaceReinforcementArea', name: undefined,
      components: { ShearReinforcement: 0 },
    });
  });

  it('does not shift reinforcement directions when a malformed list has a missing value', async () => {
    const result = extractStructuralOnDemand(await parse('IFC4',
      "#15=IFCSURFACEREINFORCEMENTAREA('Malformed',(0.001,$,0.003),(0.,0.004),0.);"));
    expect(result.reinforcementAreas?.[0].SurfaceReinforcement1).toBeUndefined();
    expect(result.reinforcementAreas?.[0].SurfaceReinforcement2).toEqual([0, 0.004]);
    expect(result.reinforcementAreas?.[0].components).toEqual({ ShearReinforcement: 0 });
  });

  it('keeps a deleted configuration result as a missing slot without inventing values or truncation', async () => {
    const store = await parse('IFC4', `${area}
      #24=IFCSTRUCTURALLOADCONFIGURATION('Configuration',(#15,#15),((0.),(4.)));
      #50=IFCSTRUCTURALSURFACEACTION('0KQ0efL39PrP5DeqBwaUNp',$,'Action',$,$,$,$,#24,.GLOBAL_COORDS.,.F.,$,.CONST.);`);
    const result = extractStructuralOnDemand(store, {
      isDeleted: id => id === 15,
      getNewEntities: () => [],
    });
    expect(result.reinforcementAreas).toEqual([]);
    expect(result.activities[0].appliedLoad?.configuration?.entries).toEqual([
      { value: undefined, dropped: 'unresolved', location: [0] },
      { value: undefined, dropped: 'unresolved', location: [4] },
    ]);
    expect(result.loadsTruncated).toBe(false);
  });

  it('respects live deletion, creation, retyping and edited lists', async () => {
    const store = await parse('IFC4', area);
    const view: StructuralExtractionView = {
      isDeleted: id => id === 15,
      getNewEntities: () => [{ expressId: 99, type: 'IFCSURFACEREINFORCEMENTAREA' }],
      getNewEntity: id => id === 99 ? { type: 'IFCSURFACEREINFORCEMENTAREA', attributes: ['New', [0.01, 0.02], null, 0] } : null,
      readEntity: (_id, _type, source) => source,
    };
    const created = extractStructuralOnDemand(store, view);
    expect(created.reinforcementAreas?.map(r => r.expressId)).toEqual([99]);
    expect(created.reinforcementAreas?.[0].SurfaceReinforcement1).toEqual([0.01, 0.02]);
    expect(extractStructuralOnDemand(store, { isDeleted: () => true, getNewEntities: () => [] }).hasStructural).toBe(false);
    const edited = extractStructuralOnDemand(store, {
      isDeleted: () => false,
      getNewEntities: () => [],
      readEntity: (_id, _type, source) => source && ({ ...source, attrs: ['Edited', [0.02, 0.01], null, 0] }),
    });
    expect(edited.reinforcementAreas?.[0].SurfaceReinforcement1).toEqual([0.02, 0.01]);
    const retyped = extractStructuralOnDemand(store, {
      isDeleted: () => false,
      getNewEntities: () => [],
      getTypeMutations: () => new Map([[15, { newType: 'IFCWALL' }]]),
    });
    expect(retyped.reinforcementAreas).toEqual([]);
  });
});
