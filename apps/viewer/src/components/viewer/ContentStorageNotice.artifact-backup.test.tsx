/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import '@/test/download-capture.js';
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { useViewerStore } from '@/store';
import { cleanup, click, render, waitFor } from '@/test/render';
import { seedArtifactModels } from '@/test/artifact-models-fixture';
import { parseArtifactProposal, type ArtifactKind } from '@/lib/assistant/artifacts/proposal-kinds';
import { previewArtifact } from '@/lib/assistant/artifacts/artifact-preview';
import { saveArtifact } from '@/lib/assistant/artifacts/artifact-save';
import { blankDocument } from '@/lib/document/presets';
import { assistantLibrary } from '@/lib/assistant/library';
import { loadSavedFilters } from '@/lib/search/saved-filters';
import { loadListDefinitions } from '@/lib/lists/persistence';
import { ContentStorageNotice } from './ContentStorageNotice';

const groups = [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall', 'IfcWallStandardCase'] }] }];
const entries: Array<{ kind: ArtifactKind; key: string; body: Record<string, unknown> }> = [
  { kind: 'filter.proposal', key: 'filters', body: { name: 'Backup actual walls', groups } },
  { kind: 'list.proposal', key: 'lists', body: { list: { name: 'Backup actual wall names', entityTypes: ['IfcWall'], groups, columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }] } } },
  { kind: 'lens.proposal', key: 'lenses', body: { lens: { name: 'Backup actual wall colors', rules: [{ name: 'Walls', groups, action: 'colorize', color: '#223344' }] } } },
];
function Notice() {
  const status = useViewerStore(state => state.documentsStorage);
  return <ContentStorageNotice status={status} retry={() => useViewerStore.getState().retryDocumentsSave()}
    restore={() => useViewerStore.getState().restoreDocuments()} />;
}
afterEach(() => { cleanup(); localStorage.clear(); });

for (const entry of entries) test(`#7218 native library download includes the saved ${entry.key} library from actual IFC evidence`, async () => {
  await seedArtifactModels({ federated: true });
  await Promise.all([assistantLibrary.initialize(), useViewerStore.getState().initializeSavedClashReports()]);
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Native backup evidence', kind: entry.kind, ...entry.body }), entry.kind);
  const preview = await previewArtifact(proposal, useViewerStore.getState());
  assert.ok(preview.matched > 0, 'the real IFC native preview must produce walls before backup');
  const saved = saveArtifact(preview.artifact);
  assert.ok(saved.ok, 'the actual native artifact save must succeed before backup');
  const rows = entry.key === 'filters' ? loadSavedFilters() : entry.key === 'lists' ? loadListDefinitions() : useViewerStore.getState().exportLenses();
  assert.ok(rows.some(row => row.name === saved.saved.name), 'the artifact is in its native persistent library before export');
  const registered = blankDocument();
  await useViewerStore.getState().upsertDocument(registered);
  const ui = render(<Notice />);
  const button = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Download library backup'));
  assert.ok(button);
  await waitFor(() => !button.disabled, 'native libraries finish loading before backup');
  const blobs: Blob[] = [];
  const download = mock.method(URL, 'createObjectURL', (value: Blob | MediaSource) => {
    assert.ok(value instanceof Blob); blobs.push(value); return 'blob:native-library-backup';
  });
  try {
    click(button);
    await waitFor(() => blobs.length === 1, 'native backup downloads one actual Blob');
    const raw: unknown = JSON.parse(await blobs[0].text());
    assert.ok(raw && typeof raw === 'object' && 'libraries' in raw);
    const libraries = raw.libraries as Record<string, unknown>;
    assert.ok(Array.isArray(libraries.document) && libraries.document.some(row => row.id === registered.id), 'existing registered document is an independent actual download control');
    assert.ok(Array.isArray(libraries[entry.key]) && libraries[entry.key].length > 0, 'native Download library backup must retain the standalone saved artifact library');
  } finally { download.mock.restore(); }
});
