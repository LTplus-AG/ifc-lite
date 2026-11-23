/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { create } from 'zustand';
import { createScriptSlice, type ScriptSlice } from './scriptSlice.js';

test('assistant turn rollback restores the pre-turn script snapshot', () => {
  const useScriptStore = create<ScriptSlice>()((...args) => createScriptSlice(...args));
  const initialScript = `
const h = bim.create.project({ Name: "Tower" });
const storey = bim.create.addIfcBuildingStorey(h, { Name: "Level 0", Elevation: 0 });
`;
  const appliedContents: string[] = [];

  useScriptStore.getState().registerScriptEditorApplyAdapter({
    apply: (nextContent) => {
      appliedContents.push(nextContent);
    },
    undo: () => {},
    redo: () => {},
  });

  useScriptStore.getState().setScriptEditorContent(initialScript);
  const baseRevision = useScriptStore.getState().scriptEditorRevision;
  useScriptStore.getState().beginAssistantScriptTurn();

  const applyResult = useScriptStore.getState().applyScriptEditOps([{
    opId: 'append-facade-fragment',
    type: 'append',
    baseRevision,
    text: '\nconst facadeOnly = true;\n',
  }], {
    intent: 'repair',
  });

  assert.equal(applyResult.ok, true);
  assert.match(useScriptStore.getState().scriptEditorContent, /facadeOnly/);
  const turnRevision = useScriptStore.getState().scriptEditorRevision;

  useScriptStore.getState().rollbackAssistantScriptTurn();

  assert.equal(useScriptStore.getState().scriptEditorContent, initialScript);
  assert.equal(useScriptStore.getState().scriptAssistantTurnSnapshot, null);
  // Content goes back, the revision moves forward: no revision number is ever reissued.
  assert.equal(useScriptStore.getState().scriptEditorRevision, turnRevision + 1);
  assert.ok(appliedContents.some((content) => content === initialScript));
});

test('a chat edit holding a revision issued before rollback is refused after rollback (#11256 follow-up)', () => {
  const useScriptStore = create<ScriptSlice>()((...args) => createScriptSlice(...args));
  useScriptStore.getState().setScriptEditorContent('const a = 1;\n');
  useScriptStore.getState().beginAssistantScriptTurn();
  useScriptStore.getState().setScriptEditorContent('const a = 2;\n');
  const heldRevision = useScriptStore.getState().scriptEditorRevision;

  useScriptStore.getState().rollbackAssistantScriptTurn();
  useScriptStore.getState().setScriptEditorContent('const b = 3;\n');

  const result = useScriptStore.getState().applyScriptEditOps([{
    opId: 'stale-chat-edit',
    type: 'append',
    baseRevision: heldRevision,
    text: 'const stale = true;\n',
  }]);

  assert.equal(result.ok, false);
  assert.equal(result.status, 'revision_conflict');
  assert.equal(useScriptStore.getState().scriptEditorContent, 'const b = 3;\n');
});

test('resetScriptEditorForNewChat clears the editor and detaches the active script', () => {
  const useScriptStore = create<ScriptSlice>()((...args) => createScriptSlice(...args));
  const appliedContents: string[] = [];

  useScriptStore.getState().registerScriptEditorApplyAdapter({
    apply: (nextContent) => {
      appliedContents.push(nextContent);
    },
    undo: () => {},
    redo: () => {},
  });

  const scriptId = useScriptStore.getState().createScript('Tower Script', 'const h = bim.create.project({ Name: "Tower" });');
  useScriptStore.getState().setScriptError('Script execution failed');

  useScriptStore.getState().resetScriptEditorForNewChat();

  assert.equal(scriptId.length > 0, true);
  assert.equal(useScriptStore.getState().activeScriptId, null);
  assert.equal(useScriptStore.getState().scriptEditorContent, '');
  assert.equal(useScriptStore.getState().scriptEditorDirty, false);
  assert.equal(useScriptStore.getState().scriptExecutionState, 'idle');
  assert.equal(useScriptStore.getState().scriptLastError, null);
  assert.equal(useScriptStore.getState().scriptAssistantTurnSnapshot, null);
  assert.deepEqual(appliedContents.at(-1), '');
});
