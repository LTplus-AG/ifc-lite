/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useViewerStore } from '@/store';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types';
import { newFlowDocument } from './persistence.js';
import type { WorkflowArtifact } from './artifact.js';

const original = useViewerStore.getState();
afterEach(() => { useViewerStore.setState(original); localStorage.clear(); });

function document(id: string): DocumentSpec {
  return { version: DOCUMENT_VERSION, id, name: id, page: { size: 'A4', orientation: 'portrait' },
    blocks: [{ kind: 'text', id: `${id}-text`, text: 'Captured report', style: 'body' }] };
}
function install(): { source: DocumentSpec; artifact: WorkflowArtifact } {
  const source = document('captured');
  useViewerStore.setState({ documents: [], flowArtifacts: [], flowDoc: newFlowDocument('Artifact workflow') });
  assert.equal(useViewerStore.getState().upsertDocument(source), true);
  const artifact: WorkflowArtifact = { id: 'pdf', name: 'report.pdf', pages: 1, warnings: [],
    blob: new Blob(['%PDF-1.4 captured revision'], { type: 'application/pdf' }),
    documentId: source.id, documentSignature: JSON.stringify(source) };
  useViewerStore.getState().setFlowArtifacts([artifact]);
  return { source, artifact };
}

test('#6612 unrelated native document edits and identical saves preserve the original downloadable PDF', () => {
  const { source, artifact } = install();
  const unrelated = document('other');
  useViewerStore.getState().upsertDocument(unrelated);
  useViewerStore.getState().upsertDocument({ ...unrelated, name: 'Edited other report' });
  useViewerStore.getState().deleteDocument(unrelated.id);
  useViewerStore.getState().upsertDocument(structuredClone(source));
  const retained = useViewerStore.getState().flowArtifacts;
  assert.equal(retained.length, 1);
  assert.equal(retained[0].blob, artifact.blob, 'PDF bytes are retained, never silently regenerated');
  assert.equal(retained[0].documentSignature, JSON.stringify(source));
});

test('#6612 editing the captured report through native document upsert invalidates its PDF', () => {
  const { source } = install();
  useViewerStore.getState().upsertDocument({ ...source,
    blocks: [{ kind: 'text', id: 'captured-text', text: 'New report content', style: 'body' }] });
  assert.deepEqual(useViewerStore.getState().flowArtifacts, []);
});

test('#6612 deleting the captured native document invalidates its PDF', () => {
  const { source } = install();
  useViewerStore.getState().deleteDocument(source.id);
  assert.deepEqual(useViewerStore.getState().flowArtifacts, []);
});

test('#6612 replacing the workflow removes artifacts from its previous graph', () => {
  install();
  const replacement = newFlowDocument('Different workflow');
  useViewerStore.setState({ savedFlows: [{ doc: replacement, updatedAt: Date.now() }] });
  useViewerStore.getState().openFlow(replacement.id);
  assert.deepEqual(useViewerStore.getState().flowArtifacts, []);
});

test('#6612 a PDF finishing after native document editing cannot restore a stale download', () => {
  const { source, artifact } = install();
  useViewerStore.getState().upsertDocument({ ...source, name: 'Edited while PDF was rendering' });
  // The export completion callback may arrive after the native edit cleared downloads.
  useViewerStore.getState().setFlowArtifacts([artifact]);
  assert.deepEqual(useViewerStore.getState().flowArtifacts, []);
});
