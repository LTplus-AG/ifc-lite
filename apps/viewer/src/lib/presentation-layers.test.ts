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
