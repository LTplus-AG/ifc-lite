/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render } from '@/test/render';
import { playgroundFiles } from './playground-files';
import { InlineDownload } from './PlaygroundChat';

afterEach(() => { mock.restoreAll(); cleanup(); });

it('#6329 names the live MCP download action before and after saving', () => {
  const downloaded = mock.method(playgroundFiles, 'download', () => undefined);
  const view = render(<InlineDownload download={{
    fileId: 'pg-file-1', filename: 'review.ifc', mimeType: 'application/x-step', size: 42,
    label: 'Save IFC',
  }} />);
  const button = view.querySelector('button');
  assert.ok(button);
  assert.equal(button.getAttribute('aria-label'), 'Save IFC');
  assert.ok(button.textContent?.includes('Save IFC'));
  click(button);
  assert.deepEqual(downloaded.mock.calls.map((call) => call.arguments), [['pg-file-1']]);
  assert.equal(button.getAttribute('aria-label'), 'Saved — click again to re-download');
  assert.ok(button.textContent?.includes('Saved — click again to re-download'),
    'saved accessible name matches visible feedback');
});
