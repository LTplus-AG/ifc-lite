/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, unwrapIfcZipWithResources, EntityExtractor } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { appearanceAssets, modelAppearanceAssets } from '../appearance/model-assets.js';
import { packagePortableIfc, packagePortableIfcAsync, portableIfcDownload, assertPortableMergeSupported } from './portable-ifc.js';
import { exportChangedModelToStep } from './changed-model-export.js';
import { createExportAdapter } from '@/sdk/adapters/export-adapter.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';

const png = () => new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Portable appearance fixture'),'2;1');
FILE_NAME('model.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,(#5),#6);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#3,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#4,$);
#6=IFCUNITASSIGNMENT((#2));
#10=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(4.,0.,0.),(0.,3.,0.)));
#11=IFCTRIANGULATEDFACESET(#10,$,.F.,((1,2,3)),$);
#13=IFCIMAGETEXTURE(.T.,.T.,'DIFFUSE',$,$,'textures/Brick.PNG');
#14=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.)));
#15=IFCINDEXEDTRIANGLETEXTUREMAP((#13),#11,#14,((1,2,3)));
#17=IFCSURFACESTYLEWITHTEXTURES((#13));
#18=IFCSURFACESTYLE($,.BOTH.,(#17));
#19=IFCSTYLEDITEM(#11,(#18),$);
#23=IFCSHAPEREPRESENTATION(#5,'Body','Tessellation',(#11));
#24=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#25=IFCBUILDINGELEMENTPROXY('0Proxy000000000000000a',$,'Surface',$,$,$,#24,$,.NOTDEFINED.);
#26=IFCBUILDINGELEMENTPROXY('0Proxy000000000000000b',$,'Other',$,$,$,#24,$,.NOTDEFINED.);
ENDSEC;
END-ISO-10303-21;`;
async function imported() {
  const previous = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  try {
    const lease = modelAppearanceAssets.begin('model');
    await lease.decode({ originalResources: new Map([['nested/textures/Brick.PNG', png()]]), modelPath: 'nested/model.ifc' });
    lease.finish(true);
  } finally { globalThis.createImageBitmap = previous; }
  return new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer);
}
afterEach(() => { modelAppearanceAssets.clear(); appearanceAssets.clear(); });
async function reopen(content: string | Uint8Array) {
  assert.ok(content instanceof Uint8Array);
  const archive = await unwrapIfcZipWithResources(new Uint8Array(content).buffer);
  assert.equal(archive.modelPath, 'nested/model.ifc');
  assert.deepEqual(archive.originalResources.get('nested/textures/Brick.PNG'), png());
  return new IfcParser().parseColumnar(archive.model);
}

// #4243: actual STEP output + IFCZIP + canonical parser, not ZIP-byte snapshots.
it('packages full and visible-subset STEP exports with original texture links and UV maps', async () => {
  const store = await imported();
  for (const visibleOnly of [false, true]) {
    const result = new StepExporter(store).export({ schema: 'IFC4', visibleOnly, isolatedEntityIds: new Set([25]) });
    const artifact = await packagePortableIfcAsync('model', result.content);
    assert.equal(artifact.ext, 'ifczip');
    const parsed = await reopen(artifact.content);
    const extractor = new EntityExtractor(parsed.source);
    const image = parsed.entityIndex.byId.get(13);
    assert.ok(image);
    assert.equal(extractor.extractEntity(image)?.attributes[5], 'textures/Brick.PNG');
    assert.ok(parsed.entityIndex.byId.has(15), 'texture-to-face UV map survives subset');
    assert.ok(parsed.entityIndex.byId.has(25));
    assert.equal(parsed.entityIndex.byId.has(26), !visibleOnly);
  }
});

it('quick changed-model and SDK subset paths return portable archives with honest filenames', async () => {
  const store = await imported();
  const quick = await exportChangedModelToStep('model', store, undefined, { schema: 'IFC4', scheduleState: null, description: 'test' });
  assert.equal(quick.ext, 'ifczip'); await reopen(quick.content);
  useViewerStore.setState(fixtureModels({ ...fixtureModel('model'), ifcDataStore: store }));
  const sdk = createExportAdapter(useViewerStore).ifc([{ modelId: 'model', expressId: 25 }], {});
  assert.ok((await reopen(sdk)).entityIndex.byId.has(25));
  assert.deepEqual(portableIfcDownload(sdk, 'chosen.ifc', 'application/x-step'), { filename: 'chosen.ifczip', mime: 'application/zip' });
});

it('places authored images relative to the nested IFC path and retains raw STEP for untextured exports', async () => {
  await imported();
  const asset = await appearanceAssets.add(png(), { owner: { kind: 'source', id: 'uploaded' } });
  const uri = modelAppearanceAssets.getAuthoredUri('model', asset.id);
  modelAppearanceAssets.registerAuthored('model', 'command', [asset.id]);
  const output = packagePortableIfc('model', source.replace('textures/Brick.PNG', uri));
  assert.ok(output.content instanceof Uint8Array);
  const zip = await unwrapIfcZipWithResources(new Uint8Array(output.content).buffer);
  assert.deepEqual(zip.originalResources.get(`nested/${uri}`), png());
  assert.throws(() => assertPortableMergeSupported(['model']), /Export each model separately/);
  assert.deepEqual(packagePortableIfc('plain', source), { content: source, ext: 'ifc', mime: 'text/plain' });
});

// #4243: an IFCXML source path must not mislabel newly serialized STEP bytes.
it('writes STEP exports from IFCXML archives with an IFC suffix in the same directory', async () => {
  const resources = { exportResources: () => ({ modelPath: 'nested/model.IFCXML', resources: new Map([['nested/textures/Brick.PNG', png()]]) }) };
  for (const artifact of [packagePortableIfc('xml', source, resources), await packagePortableIfcAsync('xml', source, resources)]) {
    assert.ok(artifact.content instanceof Uint8Array);
    const archive = await unwrapIfcZipWithResources(new Uint8Array(artifact.content).buffer);
    assert.equal(archive.modelPath, 'nested/model.ifc');
    assert.deepEqual(archive.originalResources.get('nested/textures/Brick.PNG'), png());
    const parsed = await new IfcParser().parseColumnar(archive.model);
    assert.ok(parsed.entityIndex.byId.has(15));
  }
});
