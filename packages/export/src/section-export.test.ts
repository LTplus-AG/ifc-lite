/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { renderFrameWorldOffset } from '@ifc-lite/geometry/world-frame';
import { fileURLToPath } from 'node:url';
import { IfcParser, EntityExtractor } from '@ifc-lite/parser';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { exportSectionedStep } from './section-export-entry.js';
import { MergedExporter } from './merged-exporter.js';
import { StepExporter } from './step-exporter.js';

const source = (schema = 'IFC4') => new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('section.ifc','',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
#1=IFCPROJECT('0M7tQ9Jbj1BAeHd7rqnDmQ',$,'Project',$,$,$,$,(#10),#4);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#4=IFCUNITASSIGNMENT((#2));
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#22=IFCLOCALPLACEMENT($,#11);
#41=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,10.,8.);
#42=IFCEXTRUDEDAREASOLID(#41,#11,#43,2.);
#43=IFCDIRECTION((0.,0.,1.));
#44=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#42));
#45=IFCPRODUCTDEFINITIONSHAPE($,$,(#44));
#50=IFCSLAB('0M7tQ9Jbj1BAeHd7rqnDmR',$,'Slab',$,$,#22,#45,$,.FLOOR.);
#51=IFCWALL('0M7tQ9Jbj1BAeHd7rqnDmS',$,'Wall',$,$,#22,#45,$,.NOTDEFINED.);
#52=IFCDUCTSEGMENT('0M7tQ9Jbj1BAeHd7rqnDmT',$,'Duct',$,$,#22,#45,$,.RIGIDSEGMENT.);
#60=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('2h'),$);
#61=IFCPROPERTYSET('0M7tQ9Jbj1BAeHd7rqnDmU',$,'Pset_ExportTest',$,(#60));
#62=IFCRELDEFINESBYPROPERTIES('0M7tQ9Jbj1BAeHd7rqnDmV',$,$,$,(#50,#51,#52),#61);
#70=IFCMATERIAL('Concrete',$,$);
#71=IFCRELASSOCIATESMATERIAL('0M7tQ9Jbj1BAeHd7rqnDmW',$,$,$,(#50,#51,#52),#70);
#80=IFCCLASSIFICATION('Uniclass','1',$,'Uniclass',$,$,$);
#81=IFCCLASSIFICATIONREFERENCE($,'Ss_25','Walls',#80,$,$);
#82=IFCRELASSOCIATESCLASSIFICATION('0M7tQ9Jbj1BAeHd7rqnDmX',$,$,$,(#50,#51,#52),#81);
#90=IFCBUILDINGSTOREY('0M7tQ9Jbj1BAeHd7rqnDmY',$,'Level 0',$,$,#22,$,$,.ELEMENT.,0.);
#91=IFCRELCONTAINEDINSPATIALSTRUCTURE('0M7tQ9Jbj1BAeHd7rqnDmZ',$,$,$,(#50,#51,#52),#90);
ENDSEC;
END-ISO-10303-21;`);
const planes = [{ normal: [1,0,0] as const, offset: 0 }, { normal: [0,1,0] as const, offset: 0 }];
const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });

async function meshes(bytes: Uint8Array) {
  const gp = new GeometryProcessor();
  try { await gp.init(); return await gp.process(bytes); } finally { gp.dispose(); }
}

function meshVolume(mesh: Awaited<ReturnType<typeof meshes>>['meshes'][number]) {
  const p = (i: number) => Array.from(mesh.positions.slice(i*3,i*3+3));
  let volume6 = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a,b,c] = [p(mesh.indices[i]),p(mesh.indices[i+1]),p(mesh.indices[i+2])];
    volume6 += a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]);
  }
  return Math.abs(volume6)/6;
}

const runtime = existsSync(fileURLToPath(new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url)));
describe.skipIf(!runtime)('section export through real WASM (#7711; run pnpm build:wasm)', () => {
  it('retains filled-opening metadata without leaking the baked host cutter body', async () => {
    const bytes = new TextEncoder().encode(new TextDecoder().decode(source()).replace('ENDSEC;\nEND-ISO', `
#140=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,2.);
#141=IFCEXTRUDEDAREASOLID(#140,#11,#43,2.);
#142=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#141));
#143=IFCPRODUCTDEFINITIONSHAPE($,$,(#142));
#150=IFCOPENINGELEMENT('0M7tQ9Jbj1BAeHd7rqnDn0',$,'Opening',$,$,#22,#143,$,.OPENING.);
#151=IFCRELVOIDSELEMENT('0M7tQ9Jbj1BAeHd7rqnDn1',$,$,$,#51,#150);
#152=IFCRELFILLSELEMENT('0M7tQ9Jbj1BAeHd7rqnDn2',$,$,$,#150,#52);
ENDSEC;\nEND-ISO`));
    const result = await exportSectionedStep(bytes, {planes});
    const store = await parse(result.content), extractor = new EntityExtractor(store.source!);
    expect(store.entities.getGlobalId(150)).toBe('0M7tQ9Jbj1BAeHd7rqnDn0');
    expect(extractor.extractEntity(store.entityIndex.byId.get(150)!)?.attributes[6]).toBeNull();
    expect(extractor.extractEntity(store.entityIndex.byId.get(152)!)?.attributes.slice(4)).toEqual([150,52]);
    expect(extractor.extractEntity(store.entityIndex.byId.get(151)!)?.attributes.slice(4)).toEqual([51,150]);
    const reopened = (await meshes(result.content)).meshes;
    expect(reopened).toHaveLength(3);
    expect(reopened.map(mesh => mesh.expressId).sort((a,b) => a-b)).toEqual([50,51,52]);
    expect(reopened.filter(mesh => mesh.expressId === 51).reduce((sum,mesh) => sum+meshVolume(mesh),0)).toBeCloseTo(38,4);
  });
  it('reopens a closed palette-split cube with its cut face and both authored colours', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('../../../rust/export/tests/fixtures/section_palette.ifc', import.meta.url)));
    const result = await exportSectionedStep(bytes, {planes:[{normal:[1,0,0],offset:0.5}]});
    const store = await parse(result.content);
    const extractor = new EntityExtractor(store.source!);
    const item = store.entityIndex.byType.get('IFCTRIANGULATEDFACESET')!;
    expect(item).toHaveLength(1);
    expect(extractor.extractEntity(store.entityIndex.byId.get(item[0])!)?.attributes[2]).toBe('.T.');
    expect(store.entityIndex.byType.get('IFCINDEXEDCOLOURMAP')).toHaveLength(1);
    const reopened = await meshes(result.content);
    expect(reopened.meshes).toHaveLength(2);
    expect(reopened.meshes.some(mesh => mesh.color[0]>0.89 && mesh.color[1]<0.11)).toBe(true);
    expect(reopened.meshes.some(mesh => mesh.color[1]>0.89 && mesh.color[0]<0.11)).toBe(true);
  });
  it('reopens capped slabs, walls and ducts inside every plane, with exact identity and semantic relations', async () => {
    for (const schema of ['IFC4','IFC4X3']) {
      const bytes = source(schema);
      const before = await parse(bytes);
      const result = await exportSectionedStep(bytes, { planes });
      expect(result.trimmed).toEqual([50,51,52]);
      const after = await parse(result.content);
      const pointList = after.entityIndex.byType.get('IFCCARTESIANPOINTLIST3D')![0];
      expect(new EntityExtractor(after.source!).extractEntity(after.entityIndex.byId.get(pointList)!)?.attributes).toHaveLength(schema==='IFC4X3' ? 2 : 1);
      const oldExtract = new EntityExtractor(before.source!);
      const newExtract = new EntityExtractor(after.source!);
      for (const id of [50,51,52]) {
        expect(after.entities.getTypeName(id)).toBe(before.entities.getTypeName(id));
        expect(after.entities.getGlobalId(id)).toBe(before.entities.getGlobalId(id));
        expect(newExtract.extractEntity(after.entityIndex.byId.get(id)!)?.attributes[5])
          .toEqual(oldExtract.extractEntity(before.entityIndex.byId.get(id)!)?.attributes[5]);
      }
      for (const id of [60,61,62,70,71,80,81,82,90,91]) {
        expect(newExtract.extractEntity(after.entityIndex.byId.get(id)!)?.attributes)
          .toEqual(oldExtract.extractEntity(before.entityIndex.byId.get(id)!)?.attributes);
      }
      const reopened = await meshes(result.content);
      expect(reopened.meshes).toHaveLength(3);
      expect(reopened.meshes.map(mesh => mesh.expressId).sort((a,b) => a-b)).toEqual([50,51,52]);
      for (const mesh of reopened.meshes) {
        const origin = mesh.origin ?? [0,0,0];
        for (let i = 0; i < mesh.positions.length; i += 3) {
          expect(mesh.positions[i] + origin[0]).toBeLessThanOrEqual(1e-5);
          // Reopened render meshes are Y-up: IFC +Y is viewer -Z.
          expect(mesh.positions[i+2] + origin[2]).toBeGreaterThanOrEqual(-1e-5);
        }
        expect(meshVolume(mesh)).toBeCloseTo(40, 4);
      }
      expect(bytes).toEqual(source(schema));
    }
  });

  it('keeps inside geometry byte-identical and whole elements complete; removes a fully excluded selection', async () => {
    const bytes = source();
    expect((await exportSectionedStep(bytes, { planes, mode: 'whole' })).content).toBe(bytes);
    expect((await exportSectionedStep(bytes, { planes: [{normal:[1,0,0],offset:100}] })).content).toBe(bytes);
    const empty = await exportSectionedStep(bytes, { planes: [{normal:[1,0,0],offset:-100}] });
    const after = await parse(empty.content);
    expect(after.entityIndex.byId.has(50)).toBe(false);
    expect(after.entityIndex.byId.has(51)).toBe(false);
    expect(after.entityIndex.byId.has(52)).toBe(false);
    const spatial = new TextEncoder().encode(new TextDecoder().decode(bytes).replace("#22,$,$,.ELEMENT.","#22,#45,$,.ELEMENT."));
    const excluded = await exportSectionedStep(spatial, {planes:[{normal:[1,0,0],offset:-100}]});
    const metadata = await parse(excluded.content);
    expect(metadata.entities.getGlobalId(90)).toBe(after.entities.getGlobalId(90));
    expect(new EntityExtractor(metadata.source!).extractEntity(metadata.entityIndex.byId.get(90)!)?.attributes[6]).toBeNull();
    expect((await meshes(excluded.content)).meshes).toHaveLength(0);
  });

  it('writes IFC2X3-compatible cropped boundary representations without retyping products', async () => {
    const store = await parse(source());
    const converted = new StepExporter(store).export({schema:'IFC2X3'}).content;
    const cropped = await exportSectionedStep(converted, {planes});
    const reopened = await parse(cropped.content);
    expect(reopened.schemaVersion).toBe('IFC2X3');
    expect(reopened.entities.getTypeName(50)).toBe('IfcSlab');
    expect(reopened.entityIndex.byType.get('IFCTRIANGULATEDFACESET')?.length ?? 0).toBe(0);
    // #7908: the authored slab, wall and duct each contribute one mesh; the
    // expected count must not follow the same mesher if it drops or splits one.
    const original = (await meshes(converted)).meshes;
    expect(original).toHaveLength(3);
    expect(original.map(mesh => mesh.expressId).sort((a,b) => a-b)).toEqual([50,51,52]);
    expect(reopened.entityIndex.byType.get('IFCFACETEDBREP')).toHaveLength(3);
    const croppedMeshes = (await meshes(cropped.content)).meshes;
    expect(croppedMeshes).toHaveLength(3);
    expect(croppedMeshes.map(mesh => mesh.expressId).sort((a,b) => a-b)).toEqual([50,51,52]);
  });

  it('retains clipped representations through the canonical mixed-unit federated merge and id remap', async () => {
    const cropped = await exportSectionedStep(source(), { planes });
    const model = await parse(cropped.content);
    const millimetres = new TextEncoder().encode(new TextDecoder().decode(source())
      .replaceAll('0M7tQ', '1M7tQ').replace('LENGTHUNIT.,$,.METRE.', 'LENGTHUNIT.,.MILLI.,.METRE.')
      .replace('10.,8.', '10000.,8000.').replace('#11,#43,2.', '#11,#43,2000.'));
    const peer = await parse((await exportSectionedStep(millimetres, {planes})).content);
    const merged = await new MergedExporter([{id:'a',name:'a',dataStore:model},{id:'b',name:'b',dataStore:peer}])
      .exportAsync({schema:'IFC4',unitReconciliation:'normalize'});
    expect(merged.stats.normalizedModelCount).toBe(1);
    const reopened = await meshes(merged.content);
    expect(reopened.meshes).toHaveLength(6);
    expect(new Set(reopened.meshes.map(mesh => mesh.expressId)).size).toBe(6);
    const shift = renderFrameWorldOffset(reopened.coordinateInfo).x;
    for (const mesh of reopened.meshes) {
      const maximum = Math.max(...mesh.positions.filter((_, i) => i % 3 === 0));
      expect(maximum+(mesh.origin?.[0] ?? 0)+shift).toBeLessThanOrEqual(1e-5);
    }
  });

  const realPath = fileURLToPath(new URL('../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url));
  it.skipIf(!existsSync(realPath))('crops and reopens the real Archicad Haus fixture (pnpm fixtures)', async () => {
    const bytes = new Uint8Array(readFileSync(realPath));
    const original = await meshes(bytes);
    const shift = renderFrameWorldOffset(original.coordinateInfo).x;
    const xs = original.meshes.flatMap(mesh => Array.from(mesh.positions).filter((_, i) => i % 3 === 0).map(x => x+(mesh.origin?.[0] ?? 0)+shift));
    const offset = (xs.reduce((a,b) => Math.min(a,b), Infinity) + xs.reduce((a,b) => Math.max(a,b), -Infinity)) / 2;
    const result = await exportSectionedStep(bytes, { planes: [{normal:[1,0,0],offset}] });
    expect(result.trimmed.length).toBeGreaterThan(0);
    expect(result.outside.length).toBeGreaterThan(0);
    const reopened = await meshes(result.content);
    expect(reopened.meshes.length).toBeGreaterThan(0);
    const reopenedShift = renderFrameWorldOffset(reopened.coordinateInfo).x;
    const violations = reopened.meshes.flatMap(mesh => {
      let maximum = -Infinity;
      for (let i=0;i<mesh.positions.length;i+=3) maximum=Math.max(maximum,mesh.positions[i]+(mesh.origin?.[0] ?? 0)+reopenedShift);
      return maximum>offset+0.001 ? [{expressId:mesh.expressId,ifcType:mesh.ifcType,geometryClass:mesh.geometryClass,maximum}] : [];
    });
    const evidence = { sourceSha256:createHash('sha256').update(bytes).digest('hex'), outputSha256:createHash('sha256').update(result.content).digest('hex'),
      offset, trimmed:result.trimmed, outside:result.outside, reopenedMeshes:reopened.meshes.length, violations };
    console.info('#7711 Archicad Haus export/reopen evidence', JSON.stringify(evidence));
    if (process.env.IFC_LITE_SECTION_EVIDENCE_DIR) {
      mkdirSync(process.env.IFC_LITE_SECTION_EVIDENCE_DIR, {recursive:true});
      writeFileSync(join(process.env.IFC_LITE_SECTION_EVIDENCE_DIR,'haus-cropped.ifc'),result.content);
      writeFileSync(join(process.env.IFC_LITE_SECTION_EVIDENCE_DIR,'haus-evidence.json'),JSON.stringify(evidence,null,2));
    }
    expect(violations).toEqual([]);
  }, 120_000);
});
