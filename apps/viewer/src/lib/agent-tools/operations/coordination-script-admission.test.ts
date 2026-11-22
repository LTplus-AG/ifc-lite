/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Kept out of coordination-operations.test.ts: that file runs the script sandbox, whose esbuild.wasm
// fallback logs ERR_UNKNOWN_FILE_EXTENSION, and CI's revert oracle then reads this test's red as a load failure.
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

const operations = [...coordinationScriptSessionOperations, ...coordinationScriptRunOperations];

it('refuses to replace or execute a different source after a native revision is reused (#10591 review)', async () => {
  const editor = useViewerStore.getState();
  const host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
  const commit = <T>(write: () => T) => write();
  const context: OperationExecutionContext = {
    host, commit, commitAsync: commit, ownGeometry: work => work(), retain() {},
    artifacts: operationArtifacts(host, commit),
  };
  const execute = async <T>(id: string, input: unknown = {}): Promise<T> => {
    const op = operations.find(op => op.id === id); assert.ok(op, id);
    op.validate(input); const result = await op.execute(input, context); op.validateResult(result); return result as T;
  };

  editor.setScriptEditorContent('1');
  editor.beginAssistantScriptTurn();
  editor.setScriptEditorContent('2');
  const inspected = await execute<{ revision: number; source: string }>('script.read');
  assert.equal(inspected.source, '2');
  const nativeRevision = useViewerStore.getState().scriptEditorRevision;
  editor.rollbackAssistantScriptTurn();
  editor.setScriptEditorContent('3');
  assert.equal(useViewerStore.getState().scriptEditorRevision, nativeRevision);
  await assert.rejects(execute('script.replace', { source: '4', expected_revision: inspected.revision }), /revision changed/);
  await assert.rejects(execute('script.execute', { expected_revision: inspected.revision }), /revision changed/);
  assert.equal(useViewerStore.getState().scriptEditorContent, '3');
});
