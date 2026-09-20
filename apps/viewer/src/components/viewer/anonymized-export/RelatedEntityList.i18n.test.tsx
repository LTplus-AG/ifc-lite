/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RelatedEntityList`'s own chrome reads the i18n catalogue
 * (`anonymized-export.en.ts`, #4918 slice: anonymized export): the "Seeds"
 * section label, a relationship group's `{relationship} ({role})` label,
 * and the "Toggle all …" header aria-label.
 *
 * This test exists specifically as the revert-oracle's witness for a review
 * fix on #5079 (merged): `groupLabel` used to be memoized on `[t]`, and `t`
 * (`resolve` from the locale registry) is a stable function reference
 * across renders, so the memo never re-ran on a locale switch — the
 * `sections` array derived from it could then keep a PREVIOUS locale's
 * group label. Switching the locale here and re-reading the group label
 * text is exactly the scenario that bug broke.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import type { anonymizedExportEn as AnonymizedExportEnType } from '@/i18n/catalogues/anonymized-export.en';
import type { RelatedEntities } from '@ifc-lite/export';
import { RelatedEntityList } from './RelatedEntityList.js';

let anonymizedExportEn: typeof AnonymizedExportEnType | undefined;
try {
  ({ anonymizedExportEn } = await import('@/i18n/catalogues/anonymized-export.en'));
} catch {
  anonymizedExportEn = undefined;
}
const CATALOGUE = anonymizedExportEn ?? ({} as typeof AnonymizedExportEnType);

const marked = (text: string): string => `⟦${text}⟧`;

function pseudoLocale(): Catalogue {
  const catalogue: Record<string, TranslationValue> = {};
  for (const [key, value] of Object.entries(CATALOGUE) as [string, TranslationValue][]) {
    catalogue[key] = typeof value === 'string' ? marked(value) : { one: marked(value.one ?? value.other), other: marked(value.other) };
  }
  return catalogue;
}

const PSEUDO_LOCALE = 'related-entity-list-pseudo';

function readableStrings(root: ParentNode): Set<string> {
  const out = new Set<string>();
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (value) out.add(value);
    }
    const ownText = [...el.childNodes]
      .filter((n) => n.nodeType === n.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
  return out;
}

const RELATED: RelatedEntities = {
  seeds: [1],
  groups: [
    { relationship: 'IfcRelVoidsElement', role: 'opening', expressIds: [2, 3], relationshipIds: [10] },
  ],
  all: new Set([1, 2, 3, 10]),
  truncated: false,
};

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('RelatedEntityList localization (#4918)', () => {
  it('re-translates the group label after a live locale switch (regression: #5079 review)', () => {
    const container = render(
      <RelatedEntityList
        dataStore={null}
        seeds={[1]}
        related={RELATED}
        excludedIds={new Set()}
        lockedIds={new Set()}
        onSetExcluded={() => {}}
      />,
    );
    const english = readableStrings(container);
    const expectedGroupLabel = CATALOGUE['anonymizedExport.relatedList.groupLabel'] as string;
    assert.equal(typeof expectedGroupLabel, 'string');
    const englishGroupLabel = expectedGroupLabel
      .replace('{relationship}', 'IfcRelVoidsElement')
      .replace('{role}', 'opening');
    assert.ok(english.has(englishGroupLabel), 'expected the English group label before the locale switch');

    registerLocale(PSEUDO_LOCALE, pseudoLocale());
    act(() => setLocale(PSEUDO_LOCALE));
    const after = readableStrings(container);
    act(() => setLocale('en'));

    const markedGroupLabel = marked(englishGroupLabel);
    assert.ok(
      after.has(markedGroupLabel),
      `expected the group label to re-translate after the locale switch; got: ${[...after].join(', ')}`,
    );

    const expectedSeedsLabel = CATALOGUE['anonymizedExport.relatedList.seedsLabel'] as string;
    assert.ok(english.has(expectedSeedsLabel), 'expected the English "Seeds" section label');
    assert.ok(after.has(marked(expectedSeedsLabel)), 'expected the "Seeds" section label to re-translate too');
  });
});
