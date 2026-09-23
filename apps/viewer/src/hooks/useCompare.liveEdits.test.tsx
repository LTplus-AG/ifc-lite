/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compare reads the models as edited, not as loaded (#5214 finding 2, #5312,
 * charter #5249).
 *
 * Drives the REAL `useCompare` hook over two real parsed revisions and a real
 * `MutablePropertyView` wired by `configureMutationView`, exactly as the
 * Properties panel registers it. B starts identical to A. Then, in B, one wall
 * is deleted, one renamed and one created, all unsaved. Compare must report
 * the deletion, the rename and the addition, and it must stop showing that
 * answer once a later edit makes it stale.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import { configureMutationView } from '@/utils/configureMutationView';
import { modelsAsCompared } from '@/lib/compare/comparedModels';
import { useCompare } from './useCompare.js';

const WALLS = [
  "#1=IFCWALL('0WallA0000000000000001',$,'Wall A',$,$,$,$,$,.STANDARD.);",
  "#2=IFCWALL('0WallB0000000000000002',$,'Wall B',$,$,$,$,$,.STANDARD.);",
  "#3=IFCWALL('0WallC0000000000000003',$,'Wall C',$,$,$,$,$,.STANDARD.);",
].join('\n');

async function parse(): Promise<IfcDataStore> {
  const text = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
    'DATA;', WALLS, 'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
  return new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, { disableWorkerScan: true });
}

function model(id: string, store: IfcDataStore): FederatedModel {
  return {
    id,
    name: id,
    ifcDataStore: store,
    schemaVersion: 'IFC4',
    geometryResult: { meshes: [] as MeshData[] } as unknown as GeometryResult,
    idOffset: 0,
    maxExpressId: 3,
  } as unknown as FederatedModel;
}

let hook: ReturnType<typeof useCompare> | null = null;
function Probe(): null {
  hook = useCompare();
  return null;
}
let root: Root | null = null;
let headView: MutablePropertyView;
let headStore: IfcDataStore;

beforeEach(async () => {
  hook = null;
  const [a, b] = await Promise.all([parse(), parse()]);
  headStore = b;
  headView = new MutablePropertyView(b.properties ?? null, 'B');
  configureMutationView(headView, b);
  headView.setExpressIdWatermark(3);
  useViewerStore.setState({
    models: new Map([['A', model('A', a)], ['B', model('B', b)]]),
    mutationViews: new Map([['B', headView]]),
    compareBaseModelId: 'A',
    compareHeadModelId: 'B',
    compareScope: 'both',
    compareExcludedTypes: [],
    compareResult: null,
    compareError: null,
    compareRunning: false,
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  useViewerStore.setState({ mutationViews: new Map(), compareResult: null });
});

async function run() {
  await act(async () => {
    await hook!.runComparison();
  });
  const result = useViewerStore.getState().compareResult;
  assert.ok(result, `comparison must publish (error: ${useViewerStore.getState().compareError})`);
  const byKey = new Map(result.diff.entries.map((e) => [e.key, e]));
  return { result, byKey };
}

describe('useCompare compares the edited model (#5312)', () => {
  it('control: an unedited pair of identical revisions is all unchanged', async () => {
    const { result } = await run();
    assert.deepEqual(
      { added: result.diff.counts.added, deleted: result.diff.counts.deleted, modified: result.diff.counts.modified },
      { added: 0, deleted: 0, modified: 0 },
    );
    assert.equal(result.comparedStores, undefined, 'an unedited model is compared as loaded');
  });

  it('an unsaved delete, rename and create in B are reported as deleted, modified and added', async () => {
    headView.deleteEntity(2);
    headView.setAttribute(1, 'Name', 'Wall A renamed', 'Wall A');
    const created = headView.createEntity('IfcWall', [
      '2WallD0000000000000004', null, 'Wall D', null, null, null, null, null, '.STANDARD.',
    ]).expressId;

    const { result, byKey } = await run();
    assert.equal(byKey.get('0WallB0000000000000002')?.state, 'deleted', 'the deleted wall is deleted in B');
    assert.equal(byKey.get('0WallA0000000000000001')?.state, 'modified', 'the renamed wall is modified');
    assert.deepEqual(byKey.get('0WallA0000000000000001')?.changeKinds, ['data']);
    assert.equal(byKey.get('0WallC0000000000000003')?.state, 'unchanged');
    const added = byKey.get('2WallD0000000000000004');
    assert.equal(added?.state, 'added', 'the created wall is added in B');
    assert.equal(added?.head?.ref.localId, created, 'it keeps its overlay express id');

    // Post-run readers (row names, change detail, report) see the compared store.
    const models = modelsAsCompared(useViewerStore.getState().models, result.comparedStores);
    assert.equal(models.get('B')!.ifcDataStore!.entities.getName(1), 'Wall A renamed');
    assert.equal(models.get('B')!.ifcDataStore!.entities.getName(created), 'Wall D');
    assert.equal(headStore.entities.getName(1), 'Wall A', 'the loaded store itself is untouched');
  });

  it('a later edit retires the published comparison instead of leaving a stale answer on screen', async () => {
    await run();
    await act(async () => {
      useViewerStore.getState().setAttribute('B', 3, 'Name', 'Wall C renamed', 'Wall C');
    });
    assert.equal(useViewerStore.getState().compareResult, null);

    const { byKey } = await run();
    assert.equal(byKey.get('0WallC0000000000000003')?.state, 'modified', 'the re-run sees the new edit');
  });
});
