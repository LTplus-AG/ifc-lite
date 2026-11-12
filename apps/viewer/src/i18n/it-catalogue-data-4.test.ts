/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { catalogueBatchContract } from './__tests__/catalogue-batch';

catalogueBatchContract('it', 8908, [
  'script-panel',
  'search-filters',
  'search-modal',
  'section-2d',
  'section-planes',
  'section-tool',
  'semantic',
  'semantic-assist',
  'semantic-identity',
  'semantic-results',
  'settings',
  'shared-commands',
  'sheets-pdf',
  'shell-chrome',
  'sources',
  'space-envelope',
  'split-tool',
  'stair-railing',
  'storey-context',
  'structural-glyphs',
  'structural-properties',
  'structural-review',
  'swept-disk-inspection',
  'table-corrections',
  'terrain-imagery',
  'tours',
  'trim-extend',
  'validation-editor',
  'validation-panel',
  'viewer-shell',
  'viewport-lighting',
  'visibility-reasons',
  'webgpu-troubleshooting',
  'workspace-migration',
  'zone-emission',
  'zones-panel',
]);

// #8908: the part count is independent of the change count used for plural selection.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerLocale, resolve, setLocale } from './registry';
import { requiredModule } from './__tests__/required-module';

test('#8908 Italian table summary resolves independent change and part counts', async () => {
  const { tableCorrectionsIt } = await requiredModule(() => import('./locales/it/table-corrections'), 'Italian table correction guidance must be available');
  registerLocale('it', tableCorrectionsIt);
  setLocale('it');
  try {
    for (const count of [1, 2, 1_000_000]) {
      for (const parts of [1, 5]) {
        const text = resolve('tableChanges.summary', { count, parts, unchanged: 7, issues: 3 });
        assert.ok(text.startsWith(`${count} ${count === 1 ? 'modifica' : 'modifiche'} ·`));
        assert.ok(text.includes(`parti: ${parts} · 7 già impostati · 3 saltati`));
        assert.doesNotMatch(text, /parte\/i|\{[a-z]+\}/);
      }
    }
  } finally { setLocale('en'); }
});
