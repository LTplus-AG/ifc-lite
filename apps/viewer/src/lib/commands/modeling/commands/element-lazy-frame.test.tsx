// SPDX-License-Identifier: MPL-2.0
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { useViewerStore } from '@/store';
import { seedAuthoringSample, SAMPLE_MODEL, GROUND_STOREY } from '@/test/authoring-sample-fixture';
import { getCommandRuntime } from '../runtime';
import { getModelingCommand } from '../registry';
import '../builtin';

afterEach(() => useViewerStore.getState().exitModelWorkspace());
for (const [command, change] of [['element.mirror','storey'],['element.offset','plane']] as const) {
  it(`#9296 choosing ${change} cancels a cold ${command} launch (review 4552458747)`, async () => {
    const { dataStore } = await seedAuthoringSample();
    const storeyId = [...dataStore.entities.expressId].find(id => dataStore.entities.getGlobalId(id) === GROUND_STOREY)!;
    useViewerStore.setState({ workspaceMode: 'view', session: null, activeTool: 'select' });
    assert.ok(useViewerStore.getState().enterModelWorkspace({ modelId: SAMPLE_MODEL, storeyId }));
    assert.equal(getModelingCommand(command),undefined);
    const pending = useViewerStore.getState().startCommand(command);
    assert.ok(pending instanceof Promise);
    if (change === 'storey') useViewerStore.getState().setSessionStorey(storeyId);
    else useViewerStore.getState().setWorkplane({ kind: 'storey', storeyId, offset: .2 });
    await pending;
    assert.equal(useViewerStore.getState().activeTool,'select');
    assert.equal(useViewerStore.getState().session?.activeCommandId,null);
    assert.equal(getCommandRuntime().command,null);
    assert.equal(useViewerStore.getState().session?.storeyId,storeyId);
    const plane = useViewerStore.getState().session?.workplane;
    assert.ok(plane?.kind === 'storey');
    assert.equal(plane.offset,change === 'plane' ? .2 : 0);
  });
}
