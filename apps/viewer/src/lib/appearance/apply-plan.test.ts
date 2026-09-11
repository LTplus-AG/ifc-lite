/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EntityExtractor, IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { applyAppearanceEntities, replayAppearanceEntities, replayAppearanceEntitiesInDraft } from './apply-plan.js';
import { prepareAppearanceEntities } from './prepare-plan.js';
import type { AppearanceEntityPlan } from './planner-types.js';

const SOURCE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Appearance transaction fixture'),'2;1');
FILE_NAME('appearance.ifc','',(''),(''),'','','');
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
#13=IFCIMAGETEXTURE(.T.,.T.,'DIFFUSE',$,$,'old.png');
#14=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.)));
#15=IFCINDEXEDTRIANGLETEXTUREMAP((#13),#11,#14,((1,2,3)));
#17=IFCSURFACESTYLEWITHTEXTURES((#13));
#18=IFCSURFACESTYLE($,.BOTH.,(#17));
#19=IFCSTYLEDITEM(#11,(#18),$);
#23=IFCSHAPEREPRESENTATION(#5,'Body','Tessellation',(#11));
#24=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#25=IFCBUILDINGELEMENTPROXY('0Proxy000000000000000a',$,'Surface',$,$,$,#24,$,.NOTDEFINED.);
ENDSEC;
END-ISO-10303-21;`;

async function parse(source: string | Uint8Array): Promise<IfcDataStore> {
  const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : new Uint8Array(source);
  return new IfcParser().parseColumnar(bytes.buffer);
}
function attributes(store: IfcDataStore, id: number) {
  const ref = store.entityIndex.byId.get(id);
  return ref ? new EntityExtractor(store.source).extractEntity(ref)?.attributes : undefined;
}
async function fixture() {
  const store = await parse(SOURCE);
  const view = new MutablePropertyView(store.properties, 'model');
  const editor = new StoreEditor(store, view);
  const next = view.peekNextExpressId();
  const plan: AppearanceEntityPlan = {
    sourceRevision: 'revision-1', nextExpressId: next,
    created: [
      { expressId: next, type: 'IfcImageTexture', attributes: [true, true, 'DIFFUSE', null, null, 'textures/new.png'] },
      { expressId: next + 1, type: 'IfcTextureVertexList', attributes: [[[0.25, 0], [2.25, 0], [0.25, 2]]] },
      { expressId: next + 2, type: 'IfcIndexedTriangleTextureMap', attributes: [[`#${next}`], '#11', `#${next + 1}`, [[1, 2, 3]]] },
      { expressId: next + 3, type: 'IfcSurfaceStyleWithTextures', attributes: [[`#${next}`]] },
      { expressId: next + 4, type: 'IfcSurfaceStyle', attributes: [null, '.BOTH.', [`#${next + 3}`]] },
    ],
    edits: [{ expressId: 19, index: 1, value: [`#${next + 4}`] }, { expressId: 19, index: 2, value: 'Appearance' }],
    removed: [15],
  };
  const exported = async () => parse(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content);
  return { store, view, editor, plan, exported };
}

describe('appearance entity transaction #4243', () => {
  it('exports, undoes and redoes a real texture graph without changing source geometry', async () => {
    const { store, view, editor, plan, exported } = await fixture();
    view.setPositionalAttribute(19, 2, null); // explicit null is distinct from no override
    const edit = applyAppearanceEntities(editor, view, plan, 'revision-1');
    let reopened = await exported();
    assert.equal(attributes(reopened, plan.nextExpressId)?.[5], 'textures/new.png');
    assert.equal(attributes(reopened, 15), undefined);
    assert.deepEqual(attributes(reopened, 10), attributes(store, 10));
    assert.deepEqual(attributes(reopened, 11), attributes(store, 11));
    replayAppearanceEntities(view, edit, 'undo');
    reopened = await exported();
    assert.deepEqual(attributes(reopened, 15), attributes(store, 15));
    assert.equal(attributes(reopened, plan.nextExpressId), undefined);
    assert.equal(view.getPositionalMutationsForEntity(19)?.has(2), true);
    assert.equal(view.getPositionalMutationsForEntity(19)?.get(2), null);
    assert.equal(view.getPositionalMutationsForEntity(19)?.has(1), false);
    replayAppearanceEntities(view, edit, 'redo');
    reopened = await exported();
    assert.equal(attributes(reopened, plan.nextExpressId)?.[5], 'textures/new.png');
    assert.equal(attributes(reopened, 15), undefined);
    assert.deepEqual(attributes(reopened, 11), attributes(store, 11));
  });

  it('rolls back already staged additions when a later removal fails', async () => {
    const { view, editor, plan } = await fixture();
    plan.removed = [999999];
    assert.throws(() => applyAppearanceEntities(editor, view, plan, 'revision-1'), /missing IFC entity/);
    assert.equal(editor.getNewEntities().length, 0);
    assert.equal(view.getMutations().length, 0);
    assert.equal(view.peekNextExpressId(), plan.nextExpressId);
    assert.equal(view.getPositionalMutationsForEntity(19), null);
  });

  it('rejects a stale source revision or changed allocator before any mutation', async () => {
    const { view, editor, plan } = await fixture();
    assert.throws(() => applyAppearanceEntities(editor, view, plan, 'revision-2'), /model changed/);
    editor.addEntity('IfcColourRgb', [null, 0, 0, 1]);
    const before = structuredClone(view.getMutations());
    assert.throws(() => applyAppearanceEntities(editor, view, plan, 'revision-1'), /model changed/);
    assert.deepEqual(view.getMutations(), before);
  });

  it('rejects missing, deleted and non-integral attribute targets without recording invisible edits', async () => {
    const { view, editor, plan } = await fixture();
    for (const expressId of [0, -1, NaN, 999999, 1.5]) {
      const invalid = { ...plan, edits: [{ expressId, index: 0, value: null }] };
      assert.throws(() => applyAppearanceEntities(editor, view, invalid, 'revision-1'), /conflicting attribute edits/);
      assert.equal(view.getMutations().length, 0);
    }
    editor.removeEntity(19);
    const before = structuredClone(view.getMutations());
    assert.throws(() => applyAppearanceEntities(editor, view, plan, 'revision-1'), /conflicting attribute edits/);
    assert.deepEqual(view.getMutations(), before);
  });

  it('disposes cooperative appearance without publishing allocator or IFC edits #4336', async () => {
    const { view, editor, plan } = await fixture();
    const { prepared, applied } = await prepareAppearanceEntities(editor, view, plan, 'revision-1', {});
    prepared.dispose();
    applied.created[0].attributes[5] = 'escaped.png';
    assert.equal(editor.getNewEntities().length, 0);
    assert.equal(view.getMutations().length, 0);
    assert.equal(view.peekNextExpressId(), plan.nextExpressId);
    assert.equal(view.isDeleted(15), false);
    assert.throws(() => prepared.commit(), /disposed/);
  });

  it('failed cooperative edits leave live IFC untouched after partial draft writes #4336', async () => {
    const { view, editor, plan } = await fixture();
    await assert.rejects(prepareAppearanceEntities(editor, view, { ...plan, removed: [999999] }, 'revision-1', {}), /missing IFC entity/);
    assert.equal(editor.getNewEntities().length, 0);
    assert.equal(view.getPositionalMutationsForEntity(19), null);
    assert.equal(view.peekNextExpressId(), plan.nextExpressId);
    assert.equal(view.getMutations().length, 0);
  });

  it('composed replay rollback and escaped drafts preserve committed IFC state #4243', async () => {
    const { store, view, editor, plan, exported } = await fixture();
    const { prepared, applied } = await prepareAppearanceEntities(editor, view, plan, 'revision-1', {});
    prepared.commit();
    prepared.dispose();
    applied.created[0].attributes[5] = 'escaped.png';
    assert.equal(editor.getNewEntity(plan.nextExpressId)?.attributes[5], 'textures/new.png', 'published state is detached from returned records');
    const unchanged = attributes(await exported(), plan.nextExpressId);
    assert.throws(() => view.prepareAtomic(draft => {
      replayAppearanceEntitiesInDraft(draft, applied, 'undo');
      throw new Error('replay GPU preparation failed');
    }), /replay GPU preparation failed/);
    assert.deepEqual(attributes(await exported(), plan.nextExpressId), unchanged);
    assert.equal(view.isDeleted(15), true);
    const undo = view.prepareAtomic(draft => replayAppearanceEntitiesInDraft(draft, applied, 'undo'));
    undo.commit();
    assert.deepEqual(attributes(await exported(), 15), attributes(store, 15));
    assert.equal(editor.getNewEntity(plan.nextExpressId), null);
  });

});
