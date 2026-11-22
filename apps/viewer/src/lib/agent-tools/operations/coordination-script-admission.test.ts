/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { createMainViewerToolHost } from '../main-viewer-host';
import { operationArtifacts } from './artifacts';
import type { OperationExecutionContext } from './contract';
import { coordinationScriptRunOperations } from './coordination-script-run';
import { coordinationScriptSessionOperations } from './coordination-script-session';

it('refuses to replace or execute a different source after a native revision is reused (#10591)', async () => {
  const editor = useViewerStore.getState();
  const host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
  const commit = <T>(write: () => T) => write();
  const context: OperationExecutionContext = {
    host, commit, commitAsync: commit, ownGeometry: work => work(), retain() {},
    artifacts: operationArtifacts(host, commit),
  };
  const read = coordinationScriptSessionOperations.find(op => op.id === 'script.read')!;
  const replace = coordinationScriptSessionOperations.find(op => op.id === 'script.replace')!;
  const run = coordinationScriptRunOperations.find(op => op.id === 'script.execute')!;

  editor.setScriptEditorContent('1');
  editor.beginAssistantScriptTurn();
  editor.setScriptEditorContent('2');
  const inspected = await read.execute({}, context) as { revision: number; source: string };
  assert.equal(inspected.source, '2');
  const nativeRevision = useViewerStore.getState().scriptEditorRevision;
  editor.rollbackAssistantScriptTurn();
  editor.setScriptEditorContent('3');
  assert.equal(useViewerStore.getState().scriptEditorRevision, nativeRevision);
  await assert.rejects(replace.execute({ source: '4', expected_revision: inspected.revision }, context), /revision changed/);
  await assert.rejects(run.execute({ expected_revision: inspected.revision }, context), /revision changed/);
  assert.equal(useViewerStore.getState().scriptEditorContent, '3');
});
