/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TranslationKey } from '@/i18n/en';
import type { TranslationParameters } from '@/i18n/types';

// Namespace import keeps the revert oracle conclusive: SourcesPanel is a
// pre-existing module, so reverting the production export reaches this
// assertion instead of failing the test file during module loading.
const sourcesPanel = await import('./SourcesPanel.js');
assert.equal(typeof sourcesPanel.revisionSyncMessage, 'function');
const { revisionSyncMessage } = sourcesPanel;

describe('revisionSyncMessage', () => {
  it('selects one complete catalogue message for every count shape (#5000 review)', () => {
    const seen: Array<[TranslationKey, TranslationParameters | undefined]> = [];
    const t = (key: TranslationKey, params?: TranslationParameters) => {
      seen.push([key, params]);
      return key;
    };

    revisionSyncMessage(t, 1, 0);
    revisionSyncMessage(t, 0, 2);
    revisionSyncMessage(t, 1, 1);
    revisionSyncMessage(t, 1, 2);
    revisionSyncMessage(t, 2, 1);
    revisionSyncMessage(t, 2, 2);

    assert.deepEqual(seen.map(([key]) => key), [
      'sources.sourcesPanel.revisionChangedOnly',
      'sources.sourcesPanel.revisionDeletedOnly',
      'sources.sourcesPanel.revisionChangedOneDeletedOne',
      'sources.sourcesPanel.revisionChangedOneDeletedMany',
      'sources.sourcesPanel.revisionChangedManyDeletedOne',
      'sources.sourcesPanel.revisionChangedManyDeletedMany',
    ]);
    assert.deepEqual(seen[5]?.[1], { changed: 2, deleted: 2 });
  });

  it('lets a locale reorder both combined facts and punctuation', () => {
    const t = (key: TranslationKey, params?: TranslationParameters) =>
      key === 'sources.sourcesPanel.revisionChangedManyDeletedOne'
        ? `deleted=${params?.deleted} / changed=${params?.changed}`
        : key;

    assert.equal(revisionSyncMessage(t, 3, 1), 'deleted=1 / changed=3');
  });
});
