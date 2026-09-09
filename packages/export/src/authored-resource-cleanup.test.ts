/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it, expect } from 'vitest';
import { IfcParser, EntityExtractor } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';
import { MutablePropertyView, StoreEditor, type IfcAttributeValue } from '@ifc-lite/mutations';
import { planAuthoredResourceCleanup } from './authored-resource-cleanup.js';

async function fixture(dangling = false, nested = false) {
  const source = `ISO-10303-21;
HEADER;FILE_DESCRIPTION(('Authored GC'),'2;1');FILE_NAME('gc.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#10=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));
#11=IFCTRIANGULATEDFACESET(#10,$,.F.,((1,2,3)),$);
#12=IFCIMAGETEXTURE(.T.,.T.,'DIFFUSE',$,$,'original.png');
#13=IFCSURFACESTYLEWITHTEXTURES((#12));
#14=IFCSURFACESTYLE($,.BOTH.,(#13));
${nested ? '#15=IFCBSPLINESURFACEWITHKNOTS(1,1,((#18,#10),(#10,#18)),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);' : `#15=IFCSTYLEDITEM(#11,(#${dangling ? 18 : 14}),$);`}
ENDSEC;END-ISO-10303-21;`;
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer);
  const view = new MutablePropertyView(store.properties, 'gc');
  const editor = new StoreEditor(store, view);
  const image = editor.addEntity('IfcImageTexture', [true, true, 'DIFFUSE', null, null, 'authored.png']).expressId;
  const texture = editor.addEntity('IfcSurfaceStyleWithTextures', [[`#${image}`]]).expressId;
  const style = editor.addEntity('IfcSurfaceStyle', [null, '.BOTH.', [`#${texture}`]]).expressId;
  const candidates = new Set([12, 13, 14, image, texture, style]);
  const plan = (protectedValues: string[] = []) => planAuthoredResourceCleanup(store, view, candidates, protectedValues);
  const collect = (protectedValues: string[] = []) => plan(protectedValues).entityIds;
  return { store, view, editor, image, texture, style, candidates, collect, plan };
}
async function exportedEntity(f: Awaited<ReturnType<typeof fixture>>, id: number) {
  const output = new StepExporter(f.store, f.view).export({ schema: 'IFC4', applyMutations: true }).content;
  const parsed = await new IfcParser().parseColumnar(new Uint8Array(output).buffer);
  const ref = parsed.entityIndex.byId.get(id); expect(ref).toBeDefined();
  const entity = new EntityExtractor(parsed.source).extractEntity(ref!); expect(entity).not.toBeNull();
  return entity!;
}
describe('authored appearance graph cleanup #4243', () => {
  it('drops unreachable history payloads without serializing them, but bounds reachable payloads (#4243)', async () => {
    const f = await fixture();
    const uv = f.editor.addEntity('IfcTextureVertexList', [[]]).expressId;
    // A hostile SDK payload can exceed the native planner's authored-value cap.
    // No surviving row refers to this explicitly owned, retired candidate.
    f.view.getNewEntity(uv)!.attributes[0] = new Array(8_000_001).fill(0);
    f.candidates.add(uv);
    expect(f.collect()).toEqual(new Set([f.image, f.texture, f.style, uv]));
    expect(f.view.getNewEntity(uv)).not.toBeNull();
    f.editor.setPositionalAttribute(15, 1, [`#${uv}`]);
    expect(() => f.collect()).toThrow(/attribute budget/);
  });
  it('never collects imported entities and follows effective source style overrides', async () => {
    const f = await fixture();
    expect(f.collect()).toEqual(new Set([f.image, f.texture, f.style]));
    f.editor.setPositionalAttribute(15, 1, [`#${f.style}`]);
    expect(f.collect().size).toBe(0);
    f.editor.setPositionalAttribute(15, 1, ['#14']);
    expect(f.collect()).toEqual(new Set([f.image, f.texture, f.style]));
    // The actual STEP writer applies positional overrides after named overrides.
    f.editor.setAttribute(15, 'Styles', `#${f.style}`);
    expect(f.collect()).toEqual(new Set([f.image, f.texture, f.style]));
    expect((await exportedEntity(f, 15)).attributes[1]).toEqual([14]);
  });
  it('retains an authored resource named by an originally dangling source reference', async () => {
    const f = await fixture(true);
    expect(f.style).toBe(18);
    expect(f.collect().size).toBe(0);
    f.editor.setPositionalAttribute(15, 1, ['#14']);
    expect(f.collect()).toEqual(new Set([f.image, f.texture, f.style]));
  });
  it('preserves nested source-slot refs after unrelated edits, but honors replacing that slot', async () => {
    const f = await fixture(false, true);
    f.editor.setPositionalAttribute(15, 0, 2); // UDegree, leaving ControlPointsList unchanged.
    expect(f.collect().size).toBe(0);
    f.editor.setPositionalAttribute(15, 2, [['#10', '#10'], ['#10', '#10']]);
    expect(f.collect()).toEqual(new Set([f.image, f.texture, f.style]));
  });
  it('retains history-referenced resources and live inverse texture bindings', async () => {
    const f = await fixture();
    expect(f.collect([`#${f.style}`]).size).toBe(0);
    const uv = f.editor.addEntity('IfcTextureVertexList', [[[0, 0], [1, 0], [0, 1]]]).expressId;
    const map = f.editor.addEntity('IfcIndexedTriangleTextureMap', [[`#${f.image}`], '#11', `#${uv}`, [[1, 2, 3]]]).expressId;
    f.candidates.add(uv); f.candidates.add(map);
    expect(f.collect()).toEqual(new Set([f.style, f.texture]));
    f.editor.removeEntity(map);
    expect(f.collect()).toEqual(new Set([f.style, f.texture, f.image, uv]));
  });
  it('refuses cyclic/deep authored attributes before canonical recursive reference extraction', async () => {
    const f = await fixture();
    const cycle: IfcAttributeValue[] = []; cycle.push(cycle);
    f.view.setPositionalAttribute(15, 1, cycle, true);
    expect(() => f.collect()).toThrow(/attribute budget/);
    let deep: IfcAttributeValue = `#${f.style}`;
    for (let i = 0; i < 100; i++) deep = [deep];
    f.view.setPositionalAttribute(15, 1, deep, true);
    expect(() => f.collect()).toThrow(/attribute budget/);
    expect(f.view.getNewEntity(f.image)).not.toBeNull();
  });
  it('reports effective exported image URIs, including copied URLs after the original image is collected', async () => {
    const f = await fixture();
    const copy = f.editor.addEntity('IfcImageTexture', [true, true, 'DIFFUSE', null, null, 'authored.png']).expressId;
    const cleanup = f.plan();
    expect(cleanup.entityIds.has(f.image)).toBe(true);
    expect(cleanup.retainedImageUris.has('authored.png')).toBe(true);
    f.editor.setAttribute(copy, 'URLReference', 'named.png');
    f.editor.setPositionalAttribute(copy, 5, 'positional.png');
    f.editor.setAttribute(12, 'URLReference', 'source-named.png');
    f.editor.setPositionalAttribute(12, 5, 'source-positional.png');
    expect(f.plan().retainedImageUris).toEqual(new Set(['positional.png', 'source-positional.png']));
    expect((await exportedEntity(f, copy)).attributes[5]).toBe('positional.png');
    expect((await exportedEntity(f, 12)).attributes[5]).toBe('source-positional.png');
  });
  it('resolves URI ownership with no deletion candidates and ignores references inside strings', async () => {
    const f = await fixture();
    f.editor.setPositionalAttribute(12, 5, `original-#${f.style}.png`);
    const before = new StepExporter(f.store, f.view).export({ schema: 'IFC4', applyMutations: true }).content;
    const cleanup = planAuthoredResourceCleanup(f.store, f.view, new Set());
    expect(cleanup.entityIds.size).toBe(0);
    expect(cleanup.retainedImageUris).toEqual(new Set([`original-#${f.style}.png`, 'authored.png']));
    expect(f.collect()).toEqual(new Set([f.image, f.texture, f.style]));
    const after = new StepExporter(f.store, f.view).export({ schema: 'IFC4', applyMutations: true }).content;
    expect(after).toEqual(before); // Planning never mutates the effective export.
    f.editor.removeEntity(f.image);
    expect(planAuthoredResourceCleanup(f.store, f.view, new Set()).retainedImageUris)
      .toEqual(new Set([`original-#${f.style}.png`]));
  });
  it('collects unreachable candidate cycles without dropping externally referenced cycles', async () => {
    const f = await fixture();
    f.editor.setPositionalAttribute(f.texture, 0, [`#${f.style}`, `#${f.image}`]);
    expect(f.collect().size).toBe(3);
    const unrelated = f.editor.addEntity('IfcSurfaceStyle', [null, '.BOTH.', [`#${f.style}`]]);
    expect(f.collect().size).toBe(0);
    f.editor.removeEntity(unrelated.expressId);
    expect(f.collect().size).toBe(3);
  });
});
