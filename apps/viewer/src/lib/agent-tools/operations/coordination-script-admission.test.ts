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

it('refuses to replace or execute a different source after a native revision is reused (#10591 review)', async () => {
  const editor = useViewerStore.getState();
  const host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
  const commit = <T>(write: () => T) => write();
  const context: OperationExecutionContext = {
    host, commit, commitAsync: commit, ownGeometry: work => work(), retain() {},
    artifacts: operationArtifacts(host, commit),
  };
  // Kept apart from coordination-operations.test.ts: that file runs the script sandbox, whose
  // esbuild.wasm fallback logs ERR_UNKNOWN_FILE_EXTENSION and makes CI's revert oracle read a red as a load failure.
  const execute = async (id: string, input: unknown) => {
    const op = [...coordinationScriptSessionOperations, ...coordinationScriptRunOperations].find(op => op.id === id)!;
    op.validate(input); const result = await op.execute(input, context); op.validateResult(result); return result;
  };

  editor.setScriptEditorContent('1');
  editor.beginAssistantScriptTurn();
  editor.setScriptEditorContent('2');
  const inspected = await execute('script.read', {}) as { revision: number; source: string };
  assert.equal(inspected.source, '2');
  const nativeRevision = useViewerStore.getState().scriptEditorRevision;
  editor.rollbackAssistantScriptTurn();
  editor.setScriptEditorContent('3');
  assert.equal(useViewerStore.getState().scriptEditorRevision, nativeRevision);
  await assert.rejects(execute('script.replace', { source: '4', expected_revision: inspected.revision }), /revision changed/);
  await assert.rejects(execute('script.execute', { expected_revision: inspected.revision }), /revision changed/);
  assert.equal(useViewerStore.getState().scriptEditorContent, '3');
});
