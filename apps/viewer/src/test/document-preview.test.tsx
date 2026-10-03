/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentPreview } from '@/components/viewer/document/DocumentPreview';
import { DOCUMENT_VERSION } from '@/lib/document/types';
import { render, cleanup } from './render';
import { documentPreviewReady } from './document-preview';

afterEach(cleanup);

it('#6731 readiness waits for an actual mounted paper instead of accepting absence', async () => {
  await assert.rejects(documentPreviewReady(10), /document preview finishes resolving/,
    'absence cannot satisfy the readiness condition (#6731)');
  const ui = render(<DocumentPreview document={{ version: DOCUMENT_VERSION, id: 'readiness', name: 'Readiness',
    page: { size: 'A4', orientation: 'portrait' }, blocks: [] }}
    bindings={{ models: [], activeModelId: null, today: new Date('2026-10-03') }}
    aggregations={new Map()} chartMessages={new Map()} topics={new Map()} tables={new Map()}
    selectedBlockId={null} onSelectBlock={() => {}} />);
  await documentPreviewReady();
  assert.ok(ui.querySelector('[data-preview-section]'), 'the actual composer mounted a sheet');
});
