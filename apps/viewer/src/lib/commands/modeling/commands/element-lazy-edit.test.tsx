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
it('#9296 Select cancels a cold Mirror launch before its module loads (review 4552183743)', async () => {
  const { dataStore } = await seedAuthoringSample();
  const storeyId = [...dataStore.entities.expressId].find(id => dataStore.entities.getGlobalId(id) === GROUND_STOREY)!;
  useViewerStore.setState({ workspaceMode: 'view', session: null, activeTool: 'select' });
  assert.ok(useViewerStore.getState().enterModelWorkspace({ modelId: SAMPLE_MODEL, storeyId }));
  assert.equal(getModelingCommand('element.mirror'),undefined,'a genuinely cold command registry');
  const pending = useViewerStore.getState().startCommand('element.mirror');
  assert.ok(pending instanceof Promise);
  useViewerStore.getState().setActiveTool('select');
  await pending;
  assert.equal(useViewerStore.getState().activeTool,'select');
  assert.equal(useViewerStore.getState().session?.activeCommandId,null);
  assert.equal(getCommandRuntime().command,null);
});
