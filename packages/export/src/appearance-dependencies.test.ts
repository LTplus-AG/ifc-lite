/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { IfcParser, compressSource, compressSourceInPlace } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, type IfcAttributeValue } from '@ifc-lite/mutations';
import { captureAppearanceDependencies } from './appearance-dependencies.js';

async function fixture() {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(`ISO-10303-21;
HEADER;FILE_DESCRIPTION(('Dependencies'),'2;1');FILE_NAME('guard.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#10=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));
#11=IFCTRIANGULATEDFACESET(#10,$,.F.,((1,2,3)),$);
#12=IFCIMAGETEXTURE(.T.,.T.,'DIFFUSE',$,$,'original.png');
#13=IFCSURFACESTYLEWITHTEXTURES((#12));
#14=IFCSURFACESTYLE($,.BOTH.,(#13));
#15=IFCSTYLEDITEM(#11,(#14),$);
#16=IFCCARTESIANPOINT((0.,0.,0.));
#17=IFCAXIS2PLACEMENT3D(#16,$,$);
#18=IFCLOCALPLACEMENT($,#17);
#19=IFCBUILDINGELEMENTPROXY('0Proxy000000000000000a',$,'Surface',$,$,#18,$,$,.NOTDEFINED.);
ENDSEC;END-ISO-10303-21;`).buffer);
  const view = new MutablePropertyView(store.properties, 'dependencies');
  const editor = new StoreEditor(store, view);
  const capture = () => captureAppearanceDependencies(store, view, new Set([11, 19]));
  return { store, view, editor, capture };
}

describe('effective appearance dependency replay guard #4243', () => {
  it('follows source geometry, placement, and inverse appearance while ignoring unrelated property sets', async () => {
    const f = await fixture(), guard = f.capture();
    f.view.setProperty(19, 'Pset_Test', 'Unrelated', 'value');
    expect(() => guard.validate(f.view)).not.toThrow();
    f.editor.setPositionalAttribute(10, 0, [[0, 0, 0], [2, 0, 0], [0, 1, 0]]);
    expect(() => guard.validate(f.view)).toThrow(/IFC geometry or appearance changed/);
    f.view.removePositionalMutation(10, 0);
    f.editor.setPositionalAttribute(16, 0, [2, 0, 0]);
    expect(() => guard.validate(f.view)).toThrow(/IFC geometry or appearance changed/);
    f.view.removePositionalMutation(16, 0);
    f.editor.setPositionalAttribute(12, 5, 'changed.png');
    expect(() => guard.validate(f.view)).toThrow(/IFC geometry or appearance changed/);
  });
  it('preserves source dependencies across compressed block boundaries (#4243)', async () => {
    const f = await fixture(), guard = f.capture();
    const bytes = f.store.source.slice(0, f.store.source.byteLength);
    expect(compressSourceInPlace(f.store.source, compressSource(bytes, 17))).toBe(true);
    expect(() => guard.validate(f.view)).not.toThrow();
    f.editor.setPositionalAttribute(10, 0, [[0, 0, 0], [4, 0, 0], [0, 1, 0]]);
    expect(() => guard.validate(f.view)).toThrow(/IFC geometry or appearance changed/);
  });
  it('keeps source-byte dependencies sensitive to deletion and named overrides (#4243)', async () => {
    const f = await fixture(), guard = f.capture();
    f.editor.setAttribute(19, 'Name', 'Changed source product');
    expect(() => guard.validate(f.view)).toThrow(/IFC geometry or appearance changed/);
    const deleted = await fixture(), beforeDelete = deleted.capture();
    deleted.editor.removeEntity(10);
    expect(() => beforeDelete.validate(deleted.view)).toThrow(/IFC geometry or appearance changed/);
  });
  it('follows effective SDK-created placement and point-list chains, including named overrides', async () => {
    const f = await fixture();
    const point = f.editor.addEntity('IfcCartesianPoint', [[1, 2, 3]]).expressId;
    const axis = f.editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
    const placement = f.editor.addEntity('IfcLocalPlacement', [null, `#${axis}`]).expressId;
    f.editor.setAttribute(19, 'ObjectPlacement', `#${placement}`);
    const guard = f.capture();
    f.view.setPositionalAttribute(point, 0, [4, 5, 6], true);
    expect(() => guard.validate(f.view)).toThrow(/IFC geometry or appearance changed/);
  });
  it('detects newly attached inverse style and texture-map entities without following a shared image to another object', async () => {
    const f = await fixture(), guard = f.capture();
    const uv = f.editor.addEntity('IfcTextureVertexList', [[[0, 0], [1, 0], [0, 1]]]).expressId;
    const map = f.editor.addEntity('IfcIndexedTriangleTextureMap', [['#12'], '#999', `#${uv}`, [[1, 2, 3]]]).expressId;
    expect(() => guard.validate(f.view)).not.toThrow();
    f.editor.setPositionalAttribute(map, 1, '#11');
    expect(() => guard.validate(f.view)).toThrow(/IFC geometry or appearance changed/);
    f.editor.removeEntity(map);
    f.editor.addEntity('IfcStyledItem', ['#11', ['#14'], null]);
    expect(() => guard.validate(f.view)).toThrow(/IFC geometry or appearance changed/);
  });
  it('tracks material and type appearance inheritance without following peer product geometry', async () => {
    const f = await fixture();
    const material = f.editor.addEntity('IfcMaterial', ['Material', null, null]).expressId;
    const rep = f.editor.addEntity('IfcStyledRepresentation', [null, null, 'Style', ['#15']]).expressId;
    f.editor.addEntity('IfcMaterialDefinitionRepresentation', [null, null, [`#${rep}`], `#${material}`]);
    const type = f.editor.addEntity('IfcBuildingElementProxyType', ['0Type00000000000000000', null, 'Type', null, null, null, null, null, null, '.NOTDEFINED.']).expressId;
    const peerPoint = f.editor.addEntity('IfcCartesianPoint', [[9, 0, 0]]).expressId;
    const peerAxis = f.editor.addEntity('IfcAxis2Placement3D', [`#${peerPoint}`, null, null]).expressId;
    const peerPlace = f.editor.addEntity('IfcLocalPlacement', [null, `#${peerAxis}`]).expressId;
    const peer = f.editor.addEntity('IfcBuildingElementProxy', ['0Peer00000000000000000', null, 'Peer', null, null, `#${peerPlace}`, null, null, '.NOTDEFINED.']).expressId;
    f.editor.addEntity('IfcRelDefinesByType', ['0RelType00000000000000', null, null, null, ['#19', `#${peer}`], `#${type}`]);
    f.editor.addEntity('IfcRelAssociatesMaterial', ['0RelMat000000000000000', null, null, null, [`#${type}`], `#${material}`]);
    const guard = f.capture();
    f.editor.setPositionalAttribute(peerPoint, 0, [10, 0, 0]);
    expect(() => guard.validate(f.view)).not.toThrow();
    f.editor.setPositionalAttribute(material, 0, 'Changed material');
    expect(() => guard.validate(f.view)).toThrow(/IFC geometry or appearance changed/);
  });
  it('refuses a real oversized source index before constructing the effective dependency graph', async () => {
    const records = Array.from({ length: 200_001 }, (_, index) => `#${index + 1}=IFCCARTESIANPOINT((0.,0.,0.));`).join('\n');
    const source = `ISO-10303-21;HEADER;FILE_DESCRIPTION(('Budget'),'2;1');FILE_NAME('budget.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;${records}ENDSEC;END-ISO-10303-21;`;
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(store.properties, 'budget');
    expect(store.entityIndex.byId.size + (store.deferredEntityIndex?.size ?? 0)).toBe(200_001);
    expect(() => captureAppearanceDependencies(store, view, new Set([1]))).toThrow(/entity budget/);
  }, 30_000);
  it('rejects hostile cyclic attributes before recursive STEP serialization without touching live state', async () => {
    const f = await fixture();
    const cyclic: IfcAttributeValue[] = []; cyclic.push(cyclic);
    f.view.setPositionalAttribute(10, 0, cyclic, true);
    expect(() => f.capture()).toThrow(/safety budget/);
    expect(f.view.getPositionalMutationsForEntity(10)?.get(0)).toBe(cyclic);
  });
});

const corpusPath = process.env.IFCLITE_APPEARANCE_CORPUS_IFC;
it.skipIf(!corpusPath || !existsSync(corpusPath))('accepts actual Convento wall dependencies within the byte budget (#4243; pnpm fixtures)', async () => {
  const bytes = readFileSync(corpusPath!);
  const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer);
  const view = new MutablePropertyView(store.properties, 'convento');
  new StoreEditor(store, view);
  const roots = new Set([23, 201, 667, 833]);
  for (const id of roots) expect(store.entityIndex.byId.has(id)).toBe(true);
  const guard = captureAppearanceDependencies(store, view, roots);
  expect(() => guard.validate(view)).not.toThrow();
}, 60_000);
