/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser, buildMaterialUsageIndex, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { federationRegistry } from '@ifc-lite/renderer';
import { render, advance, cleanup } from '@/test/render';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useHierarchyTree } from '@/components/viewer/hierarchy/useHierarchyTree.js';
import { MaterialTotalsPanel } from '@/components/viewer/properties/MaterialTotalsPanel.js';

const EMPTY_MODELS = new Map<string, FederatedModel>();
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project00000000000001',$,'Project',$,$,$,$,$,$);
#10=IFCWALL('0Wall00000000000000010',$,'Wall A',$,$,$,$,$,$);
#11=IFCWALL('0Wall00000000000000011',$,'Wall B',$,$,$,$,$,$);
#20=IFCMATERIAL('Concrete',$,$);
#30=IFCRELASSOCIATESMATERIAL('0RelMat000000000000030',$,$,$,(#10,#11),#20);
ENDSEC;
END-ISO-10303-21;
`;

async function parse() {
  return new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer as ArrayBuffer,
    { disableWorkerScan: true });
}

function users(store: IfcDataStore): number[] {
  return [...buildMaterialUsageIndex(store).values()]
    .find((material) => material.name === 'Concrete')?.entries.map((entry) => entry.entityId).sort((a, b) => a - b) ?? [];
}

async function waitForUsage(read: () => string | null | undefined, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 25 && read() !== expected; attempt++) await advance(20);
  assert.equal(read(), expected);
}

function Probe({ source, models = EMPTY_MODELS }: {
  source: IfcDataStore;
  models?: Map<string, FederatedModel>;
}) {
  const { treeData } = useHierarchyTree({
    models,
    ifcDataStore: models.size ? null : source,
    isMultiModel: models.size > 1,
  });
  const usage = treeData.find((node) => node.name === 'Concrete')?.globalIds ?? [];
  return <span data-testid="usage">{usage.join(',')}</span>;
}

const originalState = useViewerStore.getState();
afterEach(() => {
  cleanup();
  useViewerStore.setState(originalState, true);
  federationRegistry.clear();
});

it('refreshes material usage after each live revision without showing the stale index (#5249)', async () => {
  const source = await parse();
  const view = new MutablePropertyView(null, '__legacy__');
  view.setExpressIdWatermark(30);
  const created = view.createEntity('IfcWall',
    ['0Wall00000000000000031', null, 'Wall C', null, null, null, null, null, null]);
  view.deleteEntity(10);
  view.setPositionalAttribute(30, 4, ['#11', `#${created.expressId}`]);
  useViewerStore.setState({ hierarchyMode: 'material',
    mutationViews: new Map([['__legacy__', view]]), mutationVersion: 1 });

  const ui = render(<Probe source={source} />);
  const shown = () => ui.querySelector('[data-testid="usage"]')?.textContent;
  assert.equal(shown(), '', 'the source material index is hidden until the edited snapshot is ready');
  await waitForUsage(shown, `11,${created.expressId}`);

  act(() => {
    view.deleteEntity(11);
    view.setPositionalAttribute(30, 4, [`#${created.expressId}`]);
    useViewerStore.setState({ mutationVersion: 2 });
  });
  assert.equal(shown(), '', 'the previous revision is hidden while the new STEP snapshot loads');
  await waitForUsage(shown, String(created.expressId));
});

it('reads pending material edits registered under the legacy compatibility key (#5249)', async () => {
  const source = await parse();
  const view = new MutablePropertyView(null, 'default');
  view.deleteEntity(10);
  view.setPositionalAttribute(30, 4, ['#11']);
  useViewerStore.setState({ hierarchyMode: 'material',
    mutationViews: new Map([['default', view]]), mutationVersion: 1 });

  const ui = render(<Probe source={source} />);
  const shown = () => ui.querySelector('[data-testid="usage"]')?.textContent;
  assert.equal(shown(), '');
  await waitForUsage(shown, '11');
});

it('material totals count reflects a deleted user and an overlay-created user (#5249)', async () => {
  const source = await parse();
  const view = new MutablePropertyView(null, '__legacy__');
  view.setExpressIdWatermark(30);
  view.deleteEntity(10);
  view.setPositionalAttribute(30, 4, ['#11']);
  useViewerStore.setState({ ifcDataStore: source, models: new Map(),
    mutationViews: new Map([['__legacy__', view]]), mutationVersion: 1 });

  const ui = render(<MaterialTotalsPanel materialId={20} modelId="legacy" />);
  const count = () => [...ui.querySelectorAll('span')]
    .find((span) => span.textContent === 'Elements')?.parentElement?.lastElementChild?.textContent;
  await waitForUsage(count, '1');

  const created = view.createEntity('IfcWall',
    ['0Wall00000000000000031', null, 'Wall C', null, null, null, null, null, null]);
  view.setPositionalAttribute(30, 4, ['#11', `#${created.expressId}`]);
  act(() => useViewerStore.setState({ mutationVersion: 2 }));
  assert.equal(count(), undefined, 'stale totals are hidden while the edited snapshot reloads');
  await waitForUsage(count, '2');
});

it('material tree sees live delete/create while a second model stays isolated (#5249)', async () => {
  const a = await parse();
  const b = await parse();
  const view = new MutablePropertyView(null, 'a');
  view.setExpressIdWatermark(30);
  const created = view.createEntity('IfcWall',
    ['0Wall00000000000000031', null, 'Wall C', null, null, null, null, null, null]);
  view.deleteEntity(10);
  view.setPositionalAttribute(30, 4, ['#11', `#${created.expressId}`]);

  federationRegistry.clear();
  const offsetA = federationRegistry.registerModel('a', 100);
  const offsetB = federationRegistry.registerModel('b', 100);
  const modelA = { ...fixtureModel('a', { idOffset: offsetA }), ifcDataStore: a, schemaVersion: 'IFC4' as const };
  const modelB = { ...fixtureModel('b', { idOffset: offsetB }), ifcDataStore: b, schemaVersion: 'IFC4' as const };
  const models = fixtureModels(modelA, modelB).models;
  useViewerStore.setState({ ...fixtureModels(modelA, modelB),
    hierarchyMode: 'material', mutationViews: new Map([['a', view]]), mutationVersion: 1 });
  assert.deepEqual(users(a), [10, 11], 'the parsed source still contains the deleted wall');
  const global = (modelId: string, id: number) => useViewerStore.getState().toGlobalId(modelId, id);
  const ui = render(<Probe source={a} models={models} />);
  const shown = () => ui.querySelector('[data-testid="usage"]')?.textContent;
  assert.equal(shown(), '');
  await waitForUsage(shown, [global('a', 11), global('a', created.expressId),
    global('b', 10), global('b', 11)].join(','));

  view.deleteEntity(11);
  view.setPositionalAttribute(30, 4, [`#${created.expressId}`]);
  act(() => useViewerStore.setState({ mutationVersion: 2 }));
  assert.equal(shown(), '', 'the previous federation snapshot is hidden while the next one loads');
  await waitForUsage(shown, [global('a', created.expressId), global('b', 10), global('b', 11)].join(','));
});
