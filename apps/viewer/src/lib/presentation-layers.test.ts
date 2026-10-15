/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { resolvePresentationLayers } from './presentation-layers.js';

const fixture = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('layers.ifc','2026-10-15T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('0Wall00000000000000001',$,'Wall A',$,$,$,#10,$,$);
#2=IFCWALL('0Wall00000000000000002',$,'Wall B',$,$,$,#11,$,$);
#3=IFCWALL('0Wall00000000000000003',$,'Unrelated wall',$,$,$,#12,$,$);
#10=IFCPRODUCTDEFINITIONSHAPE($,$,(#20));
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#21));
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));
#20=IFCSHAPEREPRESENTATION(#90,'Body','MappedRepresentation',(#30,#31));
#21=IFCSHAPEREPRESENTATION(#90,'Body','MappedRepresentation',(#32));
#22=IFCSHAPEREPRESENTATION(#90,'Body','SweptSolid',(#33));
#30=IFCMAPPEDITEM(#40,#90);
#31=IFCMAPPEDITEM(#40,#90);
#32=IFCMAPPEDITEM(#40,#90);
#33=IFCEXTRUDEDAREASOLID($,#90,$,3.);
#40=IFCREPRESENTATIONMAP(#90,#23);
#23=IFCSHAPEREPRESENTATION(#90,'Body','MappedRepresentation',(#34));
#34=IFCMAPPEDITEM(#41,#90);
#41=IFCREPRESENTATIONMAP(#90,#24);
#24=IFCSHAPEREPRESENTATION(#90,'Body','SweptSolid',(#35));
#35=IFCEXTRUDEDAREASOLID($,#90,$,3.);
#50=IFCPRESENTATIONLAYERASSIGNMENT('Shared CAD layer','Description',(#23,#35,#35),'L-1');
#51=IFCPRESENTATIONLAYERWITHSTYLE('Same name',$,(#20),$,.F.,.T.,.F.,());
#52=IFCPRESENTATIONLAYERASSIGNMENT('Same name',$,(#33),$);
#53=IFCPRESENTATIONLAYERASSIGNMENT('Dangling',$,(#999),$);
#90=IFCAXIS2PLACEMENT3D($,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function parse(text = fixture) {
  return new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer,
    { disableWorkerScan: true });
}

test('#7619 resolves representations, direct items, shared nested maps and duplicate items', async () => {
  const layers = resolvePresentationLayers(await parse()).sort((a, b) => a.expressId - b.expressId);
  assert.deepEqual(layers.map(layer => [layer.expressId, layer.productIds]), [
    [50, [1, 2]], [51, [1]], [52, [3]], [53, []],
  ]);
  assert.equal(layers[0].Name, 'Shared CAD layer');
  assert.equal(layers[0].Description, 'Description');
  assert.equal(layers[0].Identifier, 'L-1');
  assert.equal(layers[1].type, 'IfcPresentationLayerWithStyle');
  // LayerOn/LayerFrozen do not remove products, and shared #90 does not
  // associate the unrelated wall with any other layer.
  assert.deepEqual(layers[1].productIds, [1]);
});

test('#7619 cyclic mapped geometry terminates and retains reachable products', async () => {
  const store = await parse(fixture.replace(
    "#24=IFCSHAPEREPRESENTATION(#90,'Body','SweptSolid',(#35));",
    "#24=IFCSHAPEREPRESENTATION(#90,'Body','MappedRepresentation',(#35,#30));"));
  assert.deepEqual(resolvePresentationLayers(store)[0].productIds, [1, 2]);
});

test('#7619 absent and retyped assignment items cannot manufacture product membership', async () => {
  const store = await parse(fixture.replace("'SweptSolid',(#33)", "'SweptSolid',(#33,#999)"));
  assert.deepEqual(resolvePresentationLayers(store).find(layer => layer.expressId === 53)?.productIds, []);
  const view = new MutablePropertyView(null, 'legacy');
  view.setAttribute(50, 'AssignedItems', '#35');
  view.setEntityType(35, 'IfcPropertySet');
  assert.deepEqual(resolvePresentationLayers(store, view)[0].productIds, []);
  view.setEntityType(50, 'IfcPresentationLayerWithStyle');
  assert.equal(resolvePresentationLayers(store, view).find(layer => layer.expressId === 50)?.type,
    'IfcPresentationLayerWithStyle');
});

test('#7619 folds current layer names, membership, positional precedence and product deletes', async () => {
  const store = await parse();
  const view = new MutablePropertyView(null, 'legacy');
  view.setAttribute(50, 'Name', 'Edited layer');
  view.setAttribute(50, 'AssignedItems', '#33');
  assert.deepEqual(resolvePresentationLayers(store, view)[0], {
    expressId: 50, type: 'IfcPresentationLayerAssignment', Name: 'Edited layer',
    Description: 'Description', Identifier: 'L-1', productIds: [3],
  });
  view.setPositionalAttribute(50, 2, [35]);
  view.setAttribute(50, 'Name', "'Quoted ''layer'''");
  // Named STRING writes preserve literal quote characters, like saved IFC.
  assert.equal(resolvePresentationLayers(store, view)[0].Name, "'Quoted ''layer'''");
  assert.deepEqual(resolvePresentationLayers(store, view)[0].productIds, [1, 2]);
  view.deleteEntity(2);
  assert.deepEqual(resolvePresentationLayers(store, view)[0].productIds, [1]);
  view.setAttribute(50, 'Name', '$');
  assert.equal(resolvePresentationLayers(store, view)[0].Name, 'IfcPresentationLayerAssignment #50');
  view.setPositionalAttribute(50, 0, 'Positional name');
  assert.equal(resolvePresentationLayers(store, view)[0].Name, 'Positional name');
  view.setPositionalAttribute(50, 0, '$');
  assert.equal(resolvePresentationLayers(store, view)[0].Name, 'IfcPresentationLayerAssignment #50');
  view.setExpressIdWatermark(100);
  const authored = view.createEntity('IfcPresentationLayerAssignment', ['Authored', null, [33], null]);
  assert.deepEqual(resolvePresentationLayers(store, view)
    .find(layer => layer.expressId === authored.expressId)?.productIds, [3]);
  view.deleteEntity(authored.expressId);
  view.deleteEntity(50);
  assert.deepEqual(resolvePresentationLayers(store, view).map(layer => layer.expressId).sort((a, b) => a - b),
    [51, 52, 53]);
});

test('#7619 nested geometric sets and topology representations preserve item ownership', async () => {
  const store = await parse(fixture.replace(
    "#22=IFCSHAPEREPRESENTATION(#90,'Body','SweptSolid',(#33));",
    "#22=IFCTOPOLOGYREPRESENTATION(#90,'Body','GeometricSet',(#60));\n"
      + '#60=IFCGEOMETRICCURVESET((#61));\n'
      + '#61=IFCCOMPOSITECURVE((#62),.F.);\n'
      + '#62=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#63);\n'
      + '#63=IFCTRIMMEDCURVE(#33,(),(),.T.,.PARAMETER.);'));
  assert.deepEqual(resolvePresentationLayers(store).find(layer => layer.expressId === 52)?.productIds, [3]);
});

function curveOperandFixture(operand: string): string {
  return fixture
    .replace("#20=IFCSHAPEREPRESENTATION(#90,'Body','MappedRepresentation',(#30,#31));",
      "#20=IFCSHAPEREPRESENTATION(#90,'Body','SweptSolid',(#60));")
    .replace("#21=IFCSHAPEREPRESENTATION(#90,'Body','MappedRepresentation',(#32));",
      "#21=IFCSHAPEREPRESENTATION(#90,'Body','SweptSolid',(#61));")
    .replace('#90=IFCAXIS2PLACEMENT3D($,$,$);', `
#60=${operand};
#61=${operand};
#70=IFCPOLYLINE((#71,#72));
#71=IFCCARTESIANPOINT((0.,0.,0.));
#72=IFCCARTESIANPOINT((0.,0.,3.));
#73=IFCPOLYLINE((#72,#74));
#74=IFCCARTESIANPOINT((1.,0.,3.));
#75=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#70);
#76=IFCARBITRARYOPENPROFILEDEF(.CURVE.,$,#70);
#77=IFCDERIVEDPROFILEDEF(.AREA.,$,#75,$,$);
#78=IFCCOMPOSITEPROFILEDEF(.AREA.,$,(#77),$);
#54=IFCPRESENTATIONLAYERASSIGNMENT('Shared curve',$,(#70),$);
#55=IFCPRESENTATIONLAYERASSIGNMENT('Shared curve point',$,(#71),$);
#90=IFCAXIS2PLACEMENT3D(#71,$,$);`);
}

test('#7619 sweep curve operands resolve shared products without leaking through placements', async t => {
  const operands = [
    'IFCSWEPTDISKSOLID(#70,0.1,$,$,$)',
    'IFCSWEPTDISKSOLIDPOLYGONAL(#70,0.1,$,$,$,$)',
    'IFCFIXEDREFERENCESWEPTAREASOLID(#78,#90,#73,$,$,$)',
    'IFCSURFACECURVESWEPTAREASOLID(#78,#90,#73,$,$,$)',
    'IFCSECTIONEDSOLIDHORIZONTAL(#73,(#78),(),.F.)',
    'IFCSECTIONEDSPINE(#73,(#78),())',
    'IFCEXTRUDEDAREASOLID(#78,#90,$,3.)',
    'IFCREVOLVEDAREASOLID(#78,#90,$,1.)',
    'IFCSURFACEOFLINEAREXTRUSION(#76,#90,$,3.)',
    'IFCOFFSETCURVE3D(#70,1.,.F.,$)',
    'IFCSURFACECURVE(#70,(),.CURVE3D.)',
  ];
  for (const operand of operands) {
    await t.test(operand.split('(')[0], async () => {
      const store = await parse(curveOperandFixture(operand));
      assert.deepEqual(store.getEntity(12)?.attributes[2], [22]);
      assert.equal(store.getEntity(33)?.attributes[1], 90,
        'unrelated wall shares the assigned point only through a placement');
      const layers = resolvePresentationLayers(store);
      assert.deepEqual(layers.find(layer => layer.expressId === 54)?.productIds, [1, 2]);
      assert.deepEqual(layers.find(layer => layer.expressId === 55)?.productIds, [1, 2]);
      if (operand.includes('#73')) {
        // Both inherited profile and subtype directrix ownership must survive.
        const view = new MutablePropertyView(null, 'legacy');
        view.setAttribute(54, 'AssignedItems', '#73');
        assert.deepEqual(resolvePresentationLayers(store, view)
          .find(layer => layer.expressId === 54)?.productIds, [1, 2]);
      }
    });
  }
});

test('#7619 swept directrix membership follows edits and deleted curves', async () => {
  const store = await parse(curveOperandFixture('IFCSWEPTDISKSOLID(#70,0.1,$,$,$)'));
  const view = new MutablePropertyView(null, 'legacy');
  view.setAttribute(60, 'Directrix', '#73');
  assert.deepEqual(resolvePresentationLayers(store, view)
    .find(layer => layer.expressId === 54)?.productIds, [2]);
  view.deleteEntity(70);
  assert.deepEqual(resolvePresentationLayers(store, view)
    .find(layer => layer.expressId === 54)?.productIds, []);
});

test('#7619 IFC4X3 curve segments retain their parent curve ownership', async () => {
  const store = await parse(curveOperandFixture('IFCCURVESEGMENT(.CONTINUOUS.,#90,0.,1.,#70)')
    .replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC4X3'))"));
  assert.deepEqual(resolvePresentationLayers(store)
    .find(layer => layer.expressId === 54)?.productIds, [1, 2]);
});

// These shape representations are owned exclusively through shape aspects:
// neither the product definition shape nor the map names them directly.
const aspectFixture = fixture.replace('#90=IFCAXIS2PLACEMENT3D', `
#60=IFCSHAPEASPECT((#70),'Product aspect',$,.T.,#10);
#61=IFCSHAPEASPECT((#71),'Mapped aspect',$,.T.,#40);
#62=IFCSHAPEASPECT((#72),'Dangling owner',$,.T.,#999);
#63=IFCSHAPEASPECT((#73),'Wrong owner class',$,.T.,#1);
#64=IFCSHAPEASPECT((#33),'Wrong shape class',$,.T.,#10);
#70=IFCSHAPEREPRESENTATION(#90,'Body','SweptSolid',(#35));
#71=IFCSHAPEREPRESENTATION(#90,'Body','SweptSolid',(#35));
#72=IFCSHAPEREPRESENTATION(#90,'Body','SweptSolid',(#35));
#73=IFCSHAPEREPRESENTATION(#90,'Body','SweptSolid',(#35));
#54=IFCPRESENTATIONLAYERASSIGNMENT('Product aspect layer',$,(#70),$);
#55=IFCPRESENTATIONLAYERASSIGNMENT('Mapped aspect layer',$,(#71),$);
#56=IFCPRESENTATIONLAYERASSIGNMENT('Dangling aspect owner',$,(#72),$);
#57=IFCPRESENTATIONLAYERASSIGNMENT('Invalid aspect owner',$,(#73),$);
#90=IFCAXIS2PLACEMENT3D`);

test('#7619 resolves shape-aspect-only representations through product shapes and shared maps', async () => {
  const store = await parse(aspectFixture);
  assert.deepEqual(store.getEntity(10)?.attributes[2], [20],
    'product shape does not reference aspect representation #70 directly');
  assert.equal(store.getEntity(40)?.attributes[1], 23,
    'shared map does not reference aspect representation #71 directly');
  const layers = resolvePresentationLayers(store);
  assert.deepEqual(layers.find(layer => layer.expressId === 54)?.productIds, [1]);
  assert.deepEqual(layers.find(layer => layer.expressId === 55)?.productIds, [1, 2]);
  assert.deepEqual(layers.find(layer => layer.expressId === 56)?.productIds, []);
  assert.deepEqual(layers.find(layer => layer.expressId === 57)?.productIds, []);
  assert.deepEqual(layers.find(layer => layer.expressId === 52)?.productIds, [3],
    'an invalid shape model reference cannot attach the unrelated wall solid to Wall A');
});

test('#7619 shape aspect ownership follows current endpoint edits and deletions', async () => {
  const store = await parse(aspectFixture);
  const view = new MutablePropertyView(null, 'legacy');
  const membership = (layerId: number) => resolvePresentationLayers(store, view)
    .find(layer => layer.expressId === layerId)?.productIds;
  view.setPositionalAttribute(60, 0, [72]);
  assert.deepEqual(membership(54), []);
  assert.deepEqual(membership(56), [1], 'edited shape model references define current membership');
  view.setPositionalAttribute(60, 0, [70]);
  view.setAttribute(60, 'PartOfProductDefinitionShape', '#12');
  assert.deepEqual(membership(54), [3]);
  view.setPositionalAttribute(60, 4, 11);
  assert.deepEqual(membership(54), [2], 'positional ownership edits win over named edits');
  view.deleteEntity(60);
  assert.deepEqual(membership(54), [], 'deleted aspects no longer contribute ownership');
  view.deleteEntity(40);
  assert.deepEqual(membership(55), [], 'deleted representation maps cannot own aspect geometry');
});

test('#7619 shape aspect ownership rejects retyped owner resources and shape models', async () => {
  const store = await parse(aspectFixture);
  const view = new MutablePropertyView(null, 'legacy');
  view.setEntityType(10, 'IfcPropertySet');
  view.setEntityType(71, 'IfcPropertySet');
  const layers = resolvePresentationLayers(store, view);
  assert.deepEqual(layers.find(layer => layer.expressId === 54)?.productIds, []);
  assert.deepEqual(layers.find(layer => layer.expressId === 55)?.productIds, []);
});

test('#7619 resolves real Archicad presentation layers to product owners', async t => {
  const path = new URL('../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      t.skip('Archicad fixture absent; run pnpm fixtures');
      return;
    }
    throw error;
  }
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(
    bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const layers = resolvePresentationLayers(store);
  assert.ok(layers.length > 0, 'real Archicad exporter provides CAD layers');
  assert.ok(layers.some(layer => layer.productIds.length > 0), 'layers resolve to product owners');
  for (const layer of layers) {
    assert.equal(new Set(layer.productIds).size, layer.productIds.length);
    for (const id of layer.productIds) {
      assert.ok(store.getEntity(id), `layer product #${id} exists in the real file`);
    }
  }
});
