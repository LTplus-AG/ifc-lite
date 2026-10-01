/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, advance, type } from '@/test/render.js';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { BUILTIN_LENSES } from '@ifc-lite/lens';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { configureMutationView } from '@/utils/configureMutationView';
import { replayWorkspaceHistory } from '@/lib/model-placement/history';
import { exportAndReparse } from '@/test/properties-panel-harness.js';
import { useLens } from '@/hooks/useLens.js';
import { BulkPropertyEditor } from './BulkPropertyEditor.js';

const step = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('stage.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'Wall A',$,$,$,$,$,.STANDARD.);
#2=IFCWALL('0bbbbbbbbbbbbbbbbbbbbb',$,'Wall B',$,$,$,$,$,.STANDARD.);
#10=IFCPROJECT('0ppppppppppppppppppppp',$,'Project',$,$,$,$,$,#12);
#11=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#12=IFCUNITASSIGNMENT((#11));
ENDSEC;
END-ISO-10303-21;`;

async function seed(federated = false) {
  const bytes = new TextEncoder().encode(step);
  const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const a = fixtureModel('a'); a.ifcDataStore = store; a.maxExpressId = 12;
  const b = fixtureModel('b', { idOffset: 100_000 }); b.ifcDataStore = store; b.maxExpressId = 12;
  useViewerStore.setState({
    ...fixtureModels(...(federated ? [a, b] : [a])),
    mutationViews: new Map(), undoStacks: new Map(), redoStacks: new Map(),
    mutationBatchTags: new Map(), dirtyModels: new Set(), mutationVersion: 0,
    collabRole: null, editEnabled: true, selectedEntityId: 1,
    selectedEntityIds: new Set(), savedLenses: [], activeLensId: null,
    lensColorMap: new Map(), lensAppliedColors: null,
  });
  return store;
}
function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  assert.ok(found, `button ${text} must render`);
  return found as HTMLButtonElement;
}
async function openPreset() {
  render(<BulkPropertyEditor trigger={<button>Open</button>} />);
  click(button('Open')); await advance(0);
  click(button('Construction stage preset')); await advance(0);
}
async function apply(value = '1') {
  const input = document.body.querySelector<HTMLInputElement>('input[placeholder="Value"]');
  assert.ok(input); type(input, value); await advance(0);
  const apply = [...document.body.querySelectorAll('button')].find(b => b.textContent?.includes('Apply to'));
  assert.ok(apply); click(apply); await advance(100);
}
function stage(modelId: string, id: number) {
  return useViewerStore.getState().mutationViews.get(modelId)?.getPropertyValue(id, 'CESIUM', 'Stage');
}
function LensProbe() { useLens(); return null; }

// #6598: drive the preset's real UI and consumer paths, never its setters directly.
describe('construction-stage preset (#6598)', () => {
  afterEach(() => { cleanup(); useViewerStore.getState().clearAllModels(); });

  it('writes an IFC integer to the selection, survives export, and is one undo step', async () => {
    const store = await seed(); await openPreset(); await apply('4');
    assert.equal(stage('a', 1), 4); assert.equal(stage('a', 2), null);
    const exported = await exportAndReparse('a', store);
    const properties = extractPropertiesOnDemand(exported, 1);
    assert.equal(properties.find(p => p.name === 'CESIUM')?.properties.find(p => p.name === 'Stage')?.value, 4);
    act(() => replayWorkspaceHistory(useViewerStore.getState(), 'undo'));
    assert.equal(stage('a', 1), null);
    act(() => replayWorkspaceHistory(useViewerStore.getState(), 'redo'));
    assert.equal(stage('a', 1), 4);
  });

  it('keeps the preset selection-scoped even when nothing is selected', async () => {
    await seed(); useViewerStore.setState({ selectedEntityId: null }); await openPreset();
    assert.equal(document.body.querySelector('button[aria-label="Target source"]')?.textContent, 'Selection');
    const apply = [...document.body.querySelectorAll('button')].find(b => b.textContent?.includes('Apply to')) as HTMLButtonElement;
    assert.equal(apply.disabled, true);
  });

  it('writes only picked elements across two models and undoes the entire run', async () => {
    await seed(true); useViewerStore.setState({ selectedEntityIds: new Set([1, 100_002]) });
    await openPreset(); await apply('2');
    assert.equal(stage('a', 1), 2); assert.equal(stage('b', 2), 2);
    assert.equal(stage('a', 2), null); assert.equal(stage('b', 1), null);
    act(() => replayWorkspaceHistory(useViewerStore.getState(), 'undo'));
    assert.equal(stage('a', 1), null); assert.equal(stage('b', 2), null);
  });

  it('resolves a newly authored entity outside the parsed ID range', async () => {
    const store = await seed();
    const view = new MutablePropertyView(store.properties ?? null, 'a'); configureMutationView(view, store);
    view.setExpressIdWatermark(12);
    const created = view.createEntity('IfcWall', ['0ccccccccccccccccccccc', null, 'New wall', null, null, null, null, null, '.STANDARD.']);
    useViewerStore.getState().registerMutationView('a', view);
    useViewerStore.setState({ selectedEntityId: created.expressId });
    await openPreset(); await apply('3');
    assert.equal(stage('a', created.expressId), 3); assert.equal(stage('a', 1), null);
  });

  for (const value of ['2oops', '1.5', 'Infinity', '9007199254740993']) {
    it(`rejects invalid integer ${value} without writing`, async () => {
      await seed(); await openPreset(); await apply(value);
      assert.equal(stage('a', 1), null);
      assert.ok(document.body.textContent?.includes('not a valid Integer'));
    });
  }

  it('refuses writes when collaboration role changes after opening', async () => {
    await seed(); await openPreset();
    act(() => useViewerStore.setState({ collabRole: 'viewer' })); await apply('2');
    assert.equal(stage('a', 1), null);
  });

  it('reports a partial write failure and leaves successful edits undoable', async () => {
    const store = await seed();
    class FailingView extends MutablePropertyView {
      override setProperty(...args: Parameters<MutablePropertyView['setProperty']>) {
        if (args[0] === 2) throw new Error('Stage write unavailable');
        return super.setProperty(...args);
      }
    }
    const view = new FailingView(store.properties ?? null, 'a'); configureMutationView(view, store);
    useViewerStore.getState().registerMutationView('a', view);
    useViewerStore.setState({ selectedEntityIds: new Set([1, 2]) });
    await openPreset(); await apply('5');
    assert.equal(stage('a', 1), 5); assert.equal(stage('a', 2), null);
    assert.ok(document.body.textContent?.includes('Stage write unavailable'));
    act(() => replayWorkspaceHistory(useViewerStore.getState(), 'undo'));
    assert.equal(stage('a', 1), null);
  });

  it('the built-in Lens reacts to assignments, undo, and model teardown', async () => {
    await seed(); render(<LensProbe />);
    const lens = BUILTIN_LENSES.find(l => l.id === 'lens-by-stage'); assert.ok(lens);
    act(() => useViewerStore.setState({ savedLenses: [lens], activeLensId: lens.id }));
    await openPreset(); await apply('7');
    assert.deepEqual([...useViewerStore.getState().lensRuleEntityIds.values()].flat(), [1]);
    act(() => replayWorkspaceHistory(useViewerStore.getState(), 'undo')); await advance(0);
    assert.equal(useViewerStore.getState().lensRuleEntityIds.size, 0);
    act(() => replayWorkspaceHistory(useViewerStore.getState(), 'redo')); await advance(0);
    assert.ok(useViewerStore.getState().lensColorMap.size > 0);
    act(() => useViewerStore.getState().clearAllModels()); await advance(0);
    assert.equal(useViewerStore.getState().lensColorMap.size, 0);
  });
});
