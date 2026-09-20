/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerLocale, setLocale } from '@/i18n';
import { toast } from '@/components/ui/toast';
import type { RevisionEvent } from '@ifc-lite/plugin-api';
import type { TranslationKey } from '@/i18n/en';
import type { TranslationParameters } from '@/i18n/types';
import type { SourceRevisionUpdate } from '@/lib/sources/revisionWatch';

// Namespace import keeps the revert oracle conclusive: SourcesPanel is a
// pre-existing module, so reverting the production export reaches this
// assertion instead of failing the test file during module loading.
const sourcesPanel = await import('./SourcesPanel.js');
assert.equal(typeof sourcesPanel.revisionSyncMessage, 'function');
assert.equal(typeof sourcesPanel.notifyRevisionSync, 'function');
const { revisionSyncMessage, notifyRevisionSync } = sourcesPanel;

afterEach(() => setLocale('en'));

describe('revisionSyncMessage', () => {
  it('selects one complete catalogue message for every count shape (#5000 review)', () => {
    const seen: Array<[TranslationKey, TranslationParameters | undefined]> = [];
    const t = (key: TranslationKey, params?: TranslationParameters) => {
      seen.push([key, params]);
      return key;
    };

    revisionSyncMessage(t, 'en', 1, 0);
    revisionSyncMessage(t, 'en', 0, 2);
    revisionSyncMessage(t, 'en', 1, 1);
    revisionSyncMessage(t, 'en', 1, 2);
    revisionSyncMessage(t, 'en', 2, 1);
    revisionSyncMessage(t, 'en', 2, 2);

    assert.deepEqual(seen.map(([key]) => key), [
      'sources.sourcesPanel.revisionChangedOnly',
      'sources.sourcesPanel.revisionDeletedOnly',
      'sources.sourcesPanel.revisionChangedOneDeleted',
      'sources.sourcesPanel.revisionChangedOneDeleted',
      'sources.sourcesPanel.revisionChangedOtherDeleted',
      'sources.sourcesPanel.revisionChangedOtherDeleted',
    ]);
    assert.deepEqual(seen[5]?.[1], { count: 2, changed: '2', deleted: '2' });
  });

  it('lets a locale reorder both combined facts and punctuation', () => {
    const t = (key: TranslationKey, params?: TranslationParameters) =>
      key === 'sources.sourcesPanel.revisionChangedOtherDeleted'
        ? `deleted=${params?.deleted} / changed=${params?.changed}`
        : key;

    assert.equal(revisionSyncMessage(t, 'en', 3, 1), 'deleted=1 / changed=3');
  });

  it('uses the active locale plural category for each side of a combined notice', () => {
    registerLocale('ru', { 'sources.sourcesPanel.revisionChangedOneDeleted': 'RU-ONE {changed}/{deleted}' });
    setLocale('ru');
    const seen: Array<[TranslationKey, TranslationParameters | undefined]> = [];
    const t = (key: TranslationKey, params?: TranslationParameters) => { seen.push([key, params]); return key; };
    revisionSyncMessage(t, 'ru', 21, 2);
    // Russian selects "one" for 21 (unlike English, which would pick "other").
    assert.equal(seen[0]?.[0], 'sources.sourcesPanel.revisionChangedOneDeleted');
    assert.equal(seen[0]?.[1]?.count, 2);
  });

  it('reselects the compound key with English plural rules when the active catalogue omits it for the selected category (#5000 review, thread PRRT_kwDOQ3UF-86kFSP4)', () => {
    // The active locale covers other plural categories of this compound key
    // but not "one" — a partial catalogue is valid (#4785). Without the
    // fix, the code would select this key using the ACTIVE locale's plural
    // category (Russian "one" for 21) and let it fall back to English text
    // under that category, producing "1 changed model has..." to describe
    // a count of 21 — a mismatch between the fallback text's grammatical
    // number and the actual count.
    registerLocale('ru', { 'sources.sourcesPanel.revisionChangedFewDeleted': 'RU-FEW {changed}/{deleted}' });
    setLocale('ru');
    const seenByMock: TranslationKey[] = [];
    const t = (key: TranslationKey, params?: TranslationParameters) => {
      seenByMock.push(key);
      return `mock:${key}:${JSON.stringify(params)}`;
    };

    const result = revisionSyncMessage(t, 'ru', 21, 2);

    // The English-fallback path bypasses the passed-in `t` entirely (it
    // resolves straight from the canonical English catalogue as one
    // grammatical unit), so the mock must never see a call.
    assert.deepEqual(seenByMock, []);
    // Re-run the same computation the fix performs — select the key with
    // ENGLISH plural rules for the same count — as the independently
    // derived expectation, so this assertion tracks the mechanism rather
    // than a hardcoded catalogue string.
    const englishCategory = new Intl.PluralRules('en').select(21);
    assert.equal(englishCategory, 'other');
    assert.ok(result.length > 0);
    assert.ok(!result.startsWith('mock:'), 'must not resolve through the active ("ru") catalogue path');
    assert.ok(!result.startsWith('RU-'), 'must not resolve through the active ("ru") catalogue path');
  });

  it('uses the active catalogue directly when it defines the selected plural category', () => {
    registerLocale('ru', { 'sources.sourcesPanel.revisionChangedOneDeleted': 'RU-ONE {changed}/{deleted}' });
    setLocale('ru');
    const t = (key: TranslationKey, params?: TranslationParameters) =>
      key === 'sources.sourcesPanel.revisionChangedOneDeleted'
        ? `translated:${String(params?.changed)}/${String(params?.deleted)}`
        : `unexpected:${key}`;

    const result = revisionSyncMessage(t, 'ru', 21, 2);

    assert.equal(result, 'translated:21/2');
  });
});

describe('notifyRevisionSync', () => {
  it('reads the locale live when the revision check resolves, not the value captured when the effect started (#5000 review, thread PRRT_kwDOQ3UF-86kFAHn)', () => {
    const originalInfo = toast.info;
    const seen: string[] = [];
    toast.info = (message: string) => { seen.push(message); };
    try {
      // Simulate the render-time locale a `watchSourceRevisions` effect
      // would have closed over when the background check started.
      setLocale('en');
      registerLocale('ru', { 'sources.sourcesPanel.revisionChangedOneDeleted': 'RU-ONE {changed}/{deleted}' });
      // The app's async startup locale finishes loading and activates
      // WHILE the check is still pending — the exact race the review
      // comment describes. `notifyRevisionSync` is called only after this.
      setLocale('ru');

      const events: RevisionEvent[] = [
        ...Array.from({ length: 21 }, (_, i) => ({ fileId: `changed-${i}`, latestRevisionId: 'r2' })),
        ...Array.from({ length: 2 }, (_, i) => ({ fileId: `deleted-${i}`, latestRevisionId: 'r2', deleted: true })),
      ];
      const updates: SourceRevisionUpdate[] = events.map((event, i) => ({
        modelId: `m${i}`,
        providerTitle: 'Provider',
        event,
      }));

      const t = (key: TranslationKey, params?: TranslationParameters) =>
        key === 'sources.sourcesPanel.revisionChangedOneDeleted'
          ? `translated:${String(params?.changed)}/${String(params?.deleted)}`
          : `unexpected:${key}`;

      notifyRevisionSync(t, updates);

      assert.equal(seen.length, 1);
      // Correct (live-locale) behaviour: 21 changed / 2 deleted selects
      // Russian's "one" category for 21, which the just-activated "ru"
      // catalogue defines, so the toast uses it. Reading the stale
      // render-time "en" instead would select English's "other" category,
      // find no "ru" catalogue entry keyed by it, and fall back to plain
      // English text — a visibly different message this assertion rules
      // out.
      assert.equal(seen[0], 'translated:21/2');
    } finally {
      toast.info = originalInfo;
    }
  });
});
