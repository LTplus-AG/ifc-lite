/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { IfcParser, EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

const data = `
#1=IFCPROJECT('2iFPi1Pg90_94gtQu544_Z',$,'Project',$,$,$,$,(#10),#5);
#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#5=IFCUNITASSIGNMENT((#2));
#6=IFCCARTESIANPOINT((0.,0.,0.));
#7=IFCDIRECTION((0.,0.,1.));
#8=IFCDIRECTION((1.,0.,0.));
#9=IFCAXIS2PLACEMENT3D(#6,#7,#8);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#9,$);
#20=IFCLOCALPLACEMENT($,#9);
#21=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4000.,2000.);
#22=IFCEXTRUDEDAREASOLID(#21,#9,#7,3000.);
#23=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#22));
#24=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#37=IFCPROJECTEDCRS('EPSG:32760',$,$,$,$,$,#2);
#38=IFCMAPCONVERSION(#10,#37,123000.,456000.,7000.,0.,1.,0.9996);
#50=IFCWALL('0M7tQ9Jbj1BAeHd7rqnDmR',$,'Original',$,$,#20,#24,$,.NOTDEFINED.);
`;
const file = (body = data) => `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;${body}\nENDSEC;\nEND-ISO-10303-21;`;
async function parse(content: string | Uint8Array): Promise<IfcDataStore> {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
}
function attrs(store: IfcDataStore, id: number) {
  const record = store.entityIndex.byId.get(id);
  if (!record) throw new Error(`Missing entity #${id}`);
  const entity = new EntityExtractor(store.source).extractEntity(record);
  if (!entity) throw new Error(`Unreadable entity #${id}`);
  return entity.attributes;
}
const options = { schema: 'IFC4', timeStamp: '2026-10-01T00:00:00' } as const;

describe('ordinary STEP export stays independent of coordinate compatibility (#6587)', () => {
  it('retains byte identity between sync and async export after the shared pass refactor', async () => {
    const store = await parse(file());
    const view = new MutablePropertyView(store.properties ?? null, 'map-transform');
    view.setAttribute(50, 'Name', 'Edited', 'Original');
    const sync = new StepExporter(store, view).export(options);
    const asyncResult = await new StepExporter(store, view).exportAsync(options);
    expect(asyncResult.content).toEqual(sync.content);
    expect(asyncResult.stats).toEqual(sync.stats);
  });
  it('refuses the async-only capability synchronously before any source edits', async () => {
    const store = await parse(file());
    expect(() => new StepExporter(store).export({ ...options, normalizeMapGeometry: true })).toThrow('requires exportAsync');
    expect(attrs(store, 38)[7]).toBe(0.9996);
  });
  it('retains the default empty-delta preparing/entities/assembling progress sequence', async () => {
    const store = await parse(file());
    const phases: string[] = [];
    const result = await new StepExporter(store).exportAsync({ ...options, deltaOnly: true, onProgress: progress => phases.push(progress.phase) });
    expect(phases).toEqual(['preparing', 'entities', 'assembling']);
    expect(result.stats.entityCount).toBe(0);
  });
});

const wasmPath = new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const wasmAvailable = existsSync(wasmPath);
if (!wasmAvailable) console.warn('Map normalization real-WASM tests skipped: run scripts/build-wasm.sh.');
describe.skipIf(!wasmAvailable)('real canonical WASM export planning (#6587)', () => {
  beforeAll(async () => {
    const { initSync } = await import('@ifc-lite/wasm');
    initSync({ module: readFileSync(wasmPath) });
  });
  it('retains named and overlay-created edits, unique modified counts, and project units', async () => {
    const store = await parse(file());
    const view = new MutablePropertyView(store.properties ?? null, 'map-transform');
    view.setAttribute(50, 'Name', 'Edited', 'Original');
    view.setExpressIdWatermark(50);
    const created = view.createEntity('IfcWall', ['0M7tQ9Jbj1BAeHd7rqnDmS', null, 'Created', null, null, '#20', '#24', null, '.NOTDEFINED.']);
    const result = await new StepExporter(store, view).exportAsync({ ...options, normalizeMapUnitsToMetres: true, normalizeMapGeometry: true });
    expect(result.stats.warnings).toEqual([]);
    const output = await parse(result.content);
    expect(attrs(output, 50)[2]).toBe('Edited');
    expect(attrs(output, created.expressId)[2]).toBe('Created');
    expect(attrs(output, 50)[6]).toBe(24);
    expect(attrs(output, created.expressId)[6]).toBe(24);
    expect(attrs(output, 2)).toEqual(attrs(store, 2));
    expect(attrs(output, 38).slice(2, 8)).toEqual([0, 0, 0, 1, 0, .001]);
    // #37 CRS, #38 map, #50 already renamed, #24 reused shape definition.
    // Created entities remain new rather than also counting as modifications.
    expect(result.stats.modifiedEntityCount).toBe(4);
    expect(view.getAttributeMutationsForEntity(50).find(edit => edit.name === 'Name')?.value).toBe('Edited');
    expect(attrs(store, 50)[5]).toBe(20);
  });
  it('refuses malformed target MapUnit atomically when geometry is the sole normalization flag', async () => {
    for (const unit of [
      '#999', '#6', '#2',
      '#60', '#61',
    ]) {
      const malformed = data.replace("$,$,$,$,$,#2);", `$,$,$,$,$,${unit});`)
        + '\n#60=IFCSIUNIT(*,.LENGTHUNIT.,.BOGUS.,.METRE.);'
        + '\n#61=IFCCONVERSIONBASEDUNIT($,.LENGTHUNIT.,\'cyclic\',#62);'
        + '\n#62=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#61);';
      const store = await parse(file(malformed));
      const ordinary = new StepExporter(store).export(options);
      const refused = await new StepExporter(store).exportAsync({ ...options, normalizeMapGeometry: true });
      expect(refused.stats.warnings.length).toBeGreaterThan(0);
      expect(refused.content).toEqual(ordinary.content);
      expect(refused.stats.modifiedEntityCount).toBe(0);
      expect(refused.stats.newEntityCount).toBe(0);
    }
  });
  it('refuses uninstantiated type geometry even when an orphan mapped item references it', async () => {
    const typeGeometry = data.replace('.MILLI.', '$') + `
#70=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#22));
#71=IFCREPRESENTATIONMAP(#9,#70);
#72=IFCBUILDINGELEMENTPROXYTYPE('0M7tQ9Jbj1BAeHd7rqnDmS',$,'Type',$,$,$,(#71),$,$,.NOTDEFINED.);
#74=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#6,1.,$);`;
    for (const orphan of ['', '\n#73=IFCMAPPEDITEM(#71,#74);']) {
      const store = await parse(file(typeGeometry + orphan));
      const ordinary = new StepExporter(store).export(options);
      const refused = await new StepExporter(store).exportAsync({ ...options, normalizeMapGeometry: true });
      expect(refused.stats.warnings.some(warning => warning.includes('uninstantiated geometry'))).toBe(true);
      expect(refused.content).toEqual(ordinary.content);
      expect(refused.stats.modifiedEntityCount).toBe(0);
      expect(refused.stats.newEntityCount).toBe(0);
    }
    // The same type is supported when its map is actually reachable from a product Body.
    const used = typeGeometry.replace("#23=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#22));",
      "#23=IFCSHAPEREPRESENTATION(#10,'Body','MappedRepresentation',(#73));") + '\n#73=IFCMAPPEDITEM(#71,#74);';
    const accepted = await new StepExporter(await parse(file(used))).exportAsync({ ...options, normalizeMapGeometry: true });
    expect(accepted.stats.warnings).toEqual([]);
    expect(accepted.stats.newEntityCount).toBeGreaterThan(0);
  });
  it('preserves both styled submeshes at the last supported depth through the canonical batch path (#6634)', async () => {
    let extra = `
#900=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#6,1.,$);
#200=IFCCARTESIANPOINT((5000.,0.,0.));
#201=IFCAXIS2PLACEMENT3D(#200,#7,#8);
#202=IFCEXTRUDEDAREASOLID(#21,#201,#7,3000.);
#260=IFCCOLOURRGB($,1.,0.,0.);
#261=IFCSURFACESTYLERENDERING(#260,0.,$,$,$,$,$,$,.NOTDEFINED.);
#262=IFCSURFACESTYLE('Red',.BOTH.,(#261));
#263=IFCSTYLEDITEM(#22,(#262),$);
#270=IFCCOLOURRGB($,0.,1.,0.);
#271=IFCSURFACESTYLERENDERING(#270,0.,$,$,$,$,$,$,.NOTDEFINED.);
#272=IFCSURFACESTYLE('Green',.BOTH.,(#271));
#273=IFCSTYLEDITEM(#202,(#272),$);`;
    let items = '#22,#202';
    for (let level = 0; level < 30; level++) {
      const rep = 1000 + level * 3;
      extra += `\n#${rep}=IFCSHAPEREPRESENTATION(#10,'Body','MappedRepresentation',(${items}));
#${rep + 1}=IFCREPRESENTATIONMAP(#9,#${rep});
#${rep + 2}=IFCMAPPEDITEM(#${rep + 1},#900);`;
      items = `#${rep + 2}`;
    }
    const source = file(data.replace('.MILLI.', '$').replace("'SweptSolid',(#22)", `'MappedRepresentation',(${items})`) + extra);
    const exported = await new StepExporter(await parse(source)).exportAsync({ ...options, normalizeMapGeometry: true });
    expect(exported.stats.warnings).toEqual([]);
    const { GeometryProcessor } = await import('@ifc-lite/geometry');
    const processor = new GeometryProcessor();
    try {
      await processor.init();
      const before = await processor.process(new TextEncoder().encode(source));
      const after = await processor.process(exported.content);
      const signature = (result: typeof before) => result.meshes.map(mesh => ({ color: mesh.color, indices: mesh.indices.length }));
      expect(signature(before)).toEqual([{ color: [1, 0, 0, 1], indices: 36 }, { color: [0, 1, 0, 1], indices: 36 }]);
      expect(signature(after)).toEqual(signature(before));
    } finally { processor.dispose(); }
  });
  it('refuses wrapper-induced mapped depth loss atomically through real WASM (#6634)', async () => {
    for (const depth of [31, 32]) {
      let extra = '\n#900=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#6,1.,$);';
      let item = 22;
      for (let level = 0; level < depth; level++) {
        const rep = 1000 + level * 3;
        extra += `\n#${rep}=IFCSHAPEREPRESENTATION(#10,'Body','MappedRepresentation',(#${item}));
#${rep + 1}=IFCREPRESENTATIONMAP(#9,#${rep});
#${rep + 2}=IFCMAPPEDITEM(#${rep + 1},#900);`;
        item = rep + 2;
      }
      const body = data.replace('.MILLI.', '$').replace("'SweptSolid',(#22)", `'MappedRepresentation',(#${item})`) + extra;
      const store = await parse(file(body));
      const ordinary = new StepExporter(store).export(options);
      const refused = await new StepExporter(store).exportAsync({ ...options, normalizeMapGeometry: true });
      expect(refused.stats.warnings.some(warning => warning.includes('normalization wrapper'))).toBe(true);
      expect(refused.content).toEqual(ordinary.content);
      expect(refused.stats.modifiedEntityCount).toBe(0);
      expect(refused.stats.newEntityCount).toBe(0);
    }
  });
  it('leaves all output geometry byte-identical on an unsupported context and frees the real handle', async () => {
    const store = await parse(file(data.replace("'Body','SweptSolid'", "'Axis','SweptSolid'")));
    const { IfcAPI } = await import('@ifc-lite/wasm');
    const free = vi.spyOn(IfcAPI.prototype, 'free');
    try {
      const base = new StepExporter(store).export({ ...options, normalizeMapUnitsToMetres: true });
      const refused = await new StepExporter(store).exportAsync({ ...options, normalizeMapUnitsToMetres: true, normalizeMapGeometry: true });
      expect(refused.stats.warnings.some(warning => warning.includes('not a supported 3D Body'))).toBe(true);
      expect(refused.content).toEqual(base.content);
      expect(refused.stats.modifiedEntityCount).toBe(base.stats.modifiedEntityCount);
      expect(refused.stats.newEntityCount).toBe(base.stats.newEntityCount);
      expect(free).toHaveBeenCalledTimes(1);
    } finally { free.mockRestore(); }
  });
  it('refuses partial/delta and schema-converting exports before backend initialization', async () => {
    const store = await parse(file());
    for (const overrides of [{ deltaOnly: true }, { includeGeometry: false }, { schema: 'IFC4X3' as const }]) {
      await expect(new StepExporter(store).exportAsync({ ...options, ...overrides, normalizeMapGeometry: true })).rejects.toThrow('requires a full geometry export');
    }
  });
});
