/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9026 item 4: with 19 authored elements the panel still read the blank
 * file's Total Entities 32 and Max Express ID 32 beside a live Elements with
 * Geometry 19. The statistics now describe the model as edited; File Size stays
 * the loaded file's, and says so. Real parse, real `addWall`, real panel.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import { render, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { setLocale } from '@/i18n';
import { buildTreeData } from '@/components/viewer/hierarchy/treeDataBuilder';
import { effectiveEntityCount, effectiveMaxExpressId } from '@/lib/effective-entity-count';
import { ModelMetadataPanel } from './ModelMetadataPanel';

const MODEL = 'model-info';
const STOREY = 40;
const SOURCE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#35=IFCSITE('1hQBAVPOr5VxhS3Jl0O47h',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#36=IFCBUILDING('3hQBAVPOr5VxhS3Jl0O47h',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#40=IFCBUILDINGSTOREY('2hQBAVPOr5VxhS3Jl0O47h',$,'L0',$,$,$,$,$,.ELEMENT.,0.);
#70=IFCRELAGGREGATES('0kTvXnbbzCWw8lcMd1dR4o',$,$,$,#1,(#35));
#71=IFCRELAGGREGATES('1kTvXnbbzCWw8lcMd1dR4o',$,$,$,#35,(#36));
#72=IFCRELAGGREGATES('2kTvXnbbzCWw8lcMd1dR4o',$,$,$,#36,(#40));
ENDSEC;
END-ISO-10303-21;
`;
const SOURCE_ENTITIES = 12;
const SOURCE_MAX_ID = 72;

afterEach(() => {
  cleanup();
  setLocale('en');
});

async function seed(): Promise<{ model: FederatedModel; view: MutablePropertyView }> {
  const bytes = new TextEncoder().encode(SOURCE);
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  assert.equal(store.entityCount, SOURCE_ENTITIES);
  const view = new MutablePropertyView(store.properties || null, MODEL);
  const model = {
    ...fixtureModel(MODEL), ifcDataStore: store, fileSize: 1946, maxExpressId: SOURCE_MAX_ID, loadedAt: 1,
    geometryResult: { meshes: [], totalTriangles: 0, totalVertices: 0 } as unknown as GeometryResult,
  } as FederatedModel;
  useViewerStore.setState({
    ...fixtureModels(model), editEnabled: true, mutationViews: new Map([[MODEL, view]]),
    storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(), mutationVersion: 0,
  });
  return { model, view };
}

function addWall(): void {
  const wall = useViewerStore.getState().addWall(MODEL, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
  assert.ok('expressId' in wall);
}

function row(container: HTMLElement, label: string): string | undefined {
  const holder = [...container.querySelectorAll('div')].find((element) =>
    [...element.children].some((child) => child.textContent === label));
  const cells = holder ? [...holder.children] : [];
  const at = cells.findIndex((child) => child.textContent === label);
  return at >= 0 ? cells[at + 1]?.textContent ?? undefined : undefined;
}

describe('Model info after authoring (#9026)', () => {
  it('reads the file before any edit', async () => {
    const { model } = await seed();
    const ui = render(<ModelMetadataPanel model={model} />);
    assert.equal(row(ui, 'File Size'), '1.9 KB');
    assert.equal(row(ui, 'Total Entities'), String(SOURCE_ENTITIES));
    assert.equal(row(ui, 'Max Express ID'), String(SOURCE_MAX_ID));
  });

  it('follows authoring live and labels the file size as the loaded file', async () => {
    const { model, view } = await seed();
    const ui = render(<ModelMetadataPanel model={model} />);
    act(() => addWall());
    const created = view.getNewEntities();
    assert.ok(created.length > 1, 'a wall writes itself and its helper entities');
    assert.equal(row(ui, 'Total Entities'), String(SOURCE_ENTITIES + created.length));
    assert.equal(row(ui, 'Max Express ID'), String(Math.max(...created.map((entity) => entity.expressId))));
    assert.equal(row(ui, 'File Size'), undefined, 'the row no longer implies the size is current');
    assert.equal(row(ui, 'File Size (as loaded)'), '1.9 KB');
  });

  it('counts a deleted source entity once, and a created-then-deleted one not at all', async () => {
    const { model, view } = await seed();
    const store = model.ifcDataStore;
    view.setExpressIdWatermark(SOURCE_MAX_ID);
    view.deleteEntity(36);
    assert.equal(effectiveEntityCount(store, view), SOURCE_ENTITIES - 1);
    const created = view.createEntity('IfcBuildingElementPart', []);
    assert.equal(effectiveEntityCount(store, view), SOURCE_ENTITIES);
    assert.equal(effectiveMaxExpressId(SOURCE_MAX_ID, view), created.expressId);
    view.deleteEntity(created.expressId);
    assert.equal(effectiveEntityCount(store, view), SOURCE_ENTITIES - 1);
    assert.equal(effectiveMaxExpressId(SOURCE_MAX_ID, view), SOURCE_MAX_ID);
  });

  it('the federated model row counts the model as edited too', async () => {
    const { model } = await seed();
    addWall();
    const other = { ...model, id: 'other', name: 'Other' } as FederatedModel;
    const models = new Map([[MODEL, model], ['other', other]]);
    const nodes = buildTreeData(models, null, { has: () => false }, true, [], undefined, undefined, undefined, undefined,
      (modelId) => useViewerStore.getState().mutationViews.get(modelId));
    const created = useViewerStore.getState().mutationViews.get(MODEL)!.getNewEntities().length;
    assert.equal(nodes.find((node) => node.id === `model-${MODEL}`)?.elementCount, SOURCE_ENTITIES + created);
    assert.equal(nodes.find((node) => node.id === 'model-other')?.elementCount, SOURCE_ENTITIES);
  });
});
