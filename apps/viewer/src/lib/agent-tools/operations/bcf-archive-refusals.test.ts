/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { ToolErrorCode } from '@ifc-lite/mcp/browser';
import { viewerHost } from '@/test/agent-tools-fixture';
import { dispatchMainViewerTool } from '../main-viewer-dispatch';

const invalidVersionArchives: [string, Record<string, Uint8Array>][] = [
  ['missing', { 'readme.txt': strToU8('No version metadata') }],
  ['ambiguous', {
    'first/bcf.version': strToU8('<Version VersionId="2.1"/>'),
    'second/bcf.version': strToU8('<Version VersionId="2.1"/>'),
  }],
];
for (const [reason, files] of invalidVersionArchives) {
  const base64 = Buffer.from(zipSync(files)).toString('base64');
  for (const [id, input] of [
    ['bcf.import', { base64, replace_project_id: '' }],
    ['bcf.importDrafts', { value: base64 }],
  ] as const) {
    it(`${id} refuses a ZIP with ${reason} bcf.version metadata (#11120)`, async () => {
      const result = await dispatchMainViewerTool(viewerHost(), 'viewer_operation_execute', {
        operation_id: id, input,
      }, { canEdit: () => true });
      assert.equal(result.errorCode, ToolErrorCode.INVALID_INPUT, result.text);
      assert.equal((result.structured as { reason?: string }).reason, 'invalid-value');
      assert.match(result.text, new RegExp(`${reason} bcf[.]version`));
    });
  }
}
