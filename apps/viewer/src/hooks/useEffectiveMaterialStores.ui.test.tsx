/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser, buildMaterialUsageIndex, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { render, advance, cleanup } from '@/test/render';
import { useViewerStore, type FederatedModel } from '@/store';
import { buildMaterialTree } from '@/components/viewer/hierarchy/treeDataBuilder';
import { loadEffectiveMaterialStores, useEffectiveMaterialStores } from './useEffectiveMaterialStores.js';

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

function Probe({ source }: { source: IfcDataStore }) {
  const { stores, ready } = useEffectiveMaterialStores(EMPTY_MODELS, source, true);
  const usage = ready
    ? [...buildMaterialUsageIndex(stores.get('legacy')!).values()]
      .find((material) => material.name === 'Concrete')?.entries.map((entry) => entry.entityId).sort((a, b) => a - b)
    : undefined;
  return <span data-testid="usage">{ready ? (usage ?? []).join(',') : 'loading'}</span>;
}

const originalState = useViewerStore.getState();
afterEach(() => {
  cleanup();
  useViewerStore.setState(originalState, true);
});

it('refreshes material usage after each live revision without showing the stale index (#5249)', async () => {
  const source = await parse();
  const view = new MutablePropertyView(null, '__legacy__');
  view.setExpressIdWatermark(30);
  const created = view.createEntity('IfcWall',
    ['0Wall00000000000000031', null, 'Wall C', null, null, null, null, null, null]);
  view.deleteEntity(10);
  view.setPositionalAttribute(30, 4, ['#11', `#${created.expressId}`]);
  useViewerStore.setState({ mutationViews: new Map([['__legacy__', view]]), mutationVersion: 1 });

  const ui = render(<Probe source={source} />);
  const shown = () => ui.querySelector('[data-testid="usage"]')?.textContent;
  assert.equal(shown(), 'loading');
  await waitForUsage(shown, `11,${created.expressId}`);

  act(() => {
    view.deleteEntity(11);
    view.setPositionalAttribute(30, 4, [`#${created.expressId}`]);
    useViewerStore.setState({ mutationVersion: 2 });
  });
  assert.equal(shown(), 'loading', 'the previous revision is hidden while the new STEP snapshot loads');
  await waitForUsage(shown, String(created.expressId));
});

it('reads pending material edits registered under the legacy compatibility key (#5249)', async () => {
  const source = await parse();
  const view = new MutablePropertyView(null, 'default');
  view.deleteEntity(10);
  view.setPositionalAttribute(30, 4, ['#11']);
  useViewerStore.setState({ mutationViews: new Map([['default', view]]), mutationVersion: 1 });

  const ui = render(<Probe source={source} />);
  const shown = () => ui.querySelector('[data-testid="usage"]')?.textContent;
  assert.equal(shown(), 'loading');
  await waitForUsage(shown, '11');
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

  const sources = [
    { modelId: 'a', store: a, schemaVersion: 'IFC4' as const },
    { modelId: 'b', store: b, schemaVersion: 'IFC4' as const },
  ];
  const views = new Map([['a', view]]);
  assert.deepEqual(users(a), [10, 11], 'the parsed source still contains the deleted wall');

  const first = await loadEffectiveMaterialStores(sources, views, 1);
  assert.deepEqual(users(first.get('a')!), [11, created.expressId]);
  assert.deepEqual(users(first.get('b')!), [10, 11], 'model B does not inherit model A edits');
  assert.equal(first.get('b'), b, 'an untouched model keeps the fast source path');
  const materialRow = buildMaterialTree(new Map(), a, new Set(), false,
    undefined, undefined, new Map([['legacy', first.get('a')!]]))
    .find((node) => node.name === 'Concrete');
  assert.deepEqual(materialRow?.expressIds, [11, created.expressId],
    'the material tree must use the effective snapshot rather than the source store');

  view.deleteEntity(11);
  view.setPositionalAttribute(30, 4, [`#${created.expressId}`]);
  const second = await loadEffectiveMaterialStores(sources, views, 2);
  assert.deepEqual(users(second.get('a')!), [created.expressId],
    'the next edit revision cannot reuse the previous material index');
  assert.deepEqual(users(second.get('b')!), [10, 11]);
});
