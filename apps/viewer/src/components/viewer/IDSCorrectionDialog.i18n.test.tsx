/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IDSCorrectionDialog` localization (#4918 slice extending `ids-panel.en.ts`
 * from #5030 to this dialog). Same pseudo-locale oracle shape as
 * `IDSPanel.i18n.test.tsx`: render the English copy, then switch to a
 * pseudo-locale that marks every `idsPanel.correction.*` key and assert the
 * marked form reappears — proving the dialog reads from the catalogue at
 * render time rather than baking English literals into the JSX.
 *
 * Exercised without a `dataStore` (no model registered for `modelId`): the
 * dialog's own "nothing to correct" fallback branch, which is reachable
 * without standing up a full `MutablePropertyView` fixture, still covers the
 * dialog chrome (title, description, alert, Close button) that #5030's
 * `IDSPanel` didn't touch.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { idsPanelEn } from '@/i18n/catalogues/ids-panel.en';
import type { IDSSpecificationResult } from '@ifc-lite/ids';
import { IDSCorrectionDialog } from './IDSCorrectionDialog.js';

type IdsPanelKey = keyof typeof idsPanelEn;
const mark = (key: IdsPanelKey) => `⟦${key}⟧`;

function pseudoCatalogue(): Catalogue {
  return Object.fromEntries(
    (Object.keys(idsPanelEn) as IdsPanelKey[]).map((key) => [key, mark(key)]),
  );
}

const specResult: IDSSpecificationResult = {
  specification: {
    id: 'spec-a',
    name: 'Wall requirements',
    ifcVersions: ['IFC4'],
    applicability: { facets: [] },
    requirements: [],
  },
  status: 'fail',
  applicableCount: 0,
  passedCount: 0,
  failedCount: 0,
  passRate: 0,
  entityResults: [],
};

function bodyText(): string {
  return document.body.textContent ?? '';
}

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('IDSCorrectionDialog localization (#4918)', () => {
  it('renders the English fallback chrome with no model registered for modelId', () => {
    render(
      <IDSCorrectionDialog
        open
        onOpenChange={() => {}}
        specResult={specResult}
        modelId="no-such-model"
        onRevalidate={async () => {}}
      />,
    );
    const text = bodyText();
    assert.match(text, /Correct Property Requirement/);
    assert.match(text, /writes through the/);
    assert.match(text, /Nothing to correct/);
    assert.match(text, /The validated model has no parsed data to edit\./);
    assert.match(text, /Close/);
  });

  it('retranslates the dialog chrome from the active pseudo-locale', () => {
    registerLocale('en-x-ids-correction-pseudo', pseudoCatalogue());
    render(
      <IDSCorrectionDialog
        open
        onOpenChange={() => {}}
        specResult={specResult}
        modelId="no-such-model"
        onRevalidate={async () => {}}
      />,
    );
    act(() => setLocale('en-x-ids-correction-pseudo'));
    const text = bodyText();
    assert.match(text, /⟦idsPanel\.correction\.title⟧/);
    assert.match(text, /⟦idsPanel\.correction\.description⟧/);
    assert.match(text, /⟦idsPanel\.correction\.nothingToCorrect⟧/);
    assert.match(text, /⟦idsPanel\.correction\.noParsedData⟧/);
    assert.match(text, /⟦idsPanel\.correction\.close⟧/);
    assert.doesNotMatch(text, /Nothing to correct/, 'English literal must not survive a locale switch');
  });
});
