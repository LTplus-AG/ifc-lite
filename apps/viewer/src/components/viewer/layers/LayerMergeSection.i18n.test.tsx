/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `LayerMergeSection`'s own chrome reads the i18n catalogue (#4918 layers
 * slice, `layers-panel.en.ts`): the picker labels, the preview/status line,
 * bulk-resolution controls, and conflict rows. The section self-hides while
 * the local browser layer store has no candidates, so every test seeds one
 * real layer into the (memory-only, no IndexedDB in this environment) store
 * before rendering.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { resolve } from '@/i18n/registry';
import { en } from '@/i18n/en';
import type { TranslationParameters, TranslationValue, PluralTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { getBrowserLayerStore, DEFAULT_LOCAL_REF } from '@/lib/layers/browser-store';
import { computeLayerId, setProvenance } from '@ifc-lite/ifcx';
import type { IfcxFile } from '@ifc-lite/ifcx';
import { LayerMergeSection } from './LayerMergeSection.js';

const CATALOGUE: Catalogue = Object.fromEntries(
  Object.entries(en).filter(([key]) => key.startsWith('layersPanel.merge.')),
);
const KEYS = Object.keys(CATALOGUE) as (keyof typeof CATALOGUE)[];

function markValue(value: TranslationValue): TranslationValue {
  if (typeof value === 'string') return `⟦${value}⟧`;
  const marked: Record<string, string> = {};
  for (const [category, text] of Object.entries(value as PluralTranslation)) {
    if (typeof text === 'string') marked[category] = `⟦${text}⟧`;
  }
  return marked as PluralTranslation;
}

const PSEUDO: Catalogue = Object.fromEntries(KEYS.map((key) => [key, markValue(CATALOGUE[key]!)]));
const BASELINE_LOCALE = 'en';
const PSEUDO_LOCALE = 'layers-merge-pseudo';

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

interface Occurrence {
  key: string;
  params?: TranslationParameters;
}

function assertAllTranslate(occurrences: Occurrence[], englishDom: Set<string>, afterDom: Set<string>): void {
  for (const occ of occurrences) {
    const english = resolve(occ.key as never, occ.params).trim();
    assert.ok(
      englishDom.has(english),
      `${occ.key}: expected English text ${JSON.stringify(english)} to be on screen before the locale switch`,
    );
  }
  act(() => setLocale(PSEUDO_LOCALE));
  try {
    for (const occ of occurrences) {
      const pseudo = resolve(occ.key as never, occ.params).trim();
      assert.ok(
        afterDom.has(pseudo),
        `${occ.key}: "${pseudo}" must be translated, marked text not found in the switched-locale DOM`,
      );
    }
  } finally {
    act(() => setLocale(BASELINE_LOCALE));
  }
}

function domAfterPseudo(container: ParentNode): Set<string> {
  act(() => setLocale(PSEUDO_LOCALE));
  const set = readableStrings(container);
  act(() => setLocale(BASELINE_LOCALE));
  return set;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function candidateFile(): IfcxFile {
  const draft: IfcxFile = {
    header: { id: '', ifcxVersion: '1', dataVersion: '1', author: 'test', timestamp: '2026-09-20T00:00:00Z' },
    imports: [],
    schemas: {},
    data: [],
  };
  const withProvenance = setProvenance(draft, {
    v: 1,
    author: { kind: 'human', principal: 'louis@lt.plus' },
    intent: 'Set fire ratings for EG walls',
    created: '2026-09-20T00:00:00Z',
    base: null,
    parents: [],
    scope_claim: [],
    identity_map: [],
    checks: [],
    merge: null,
    signatures: [],
  });
  const id = computeLayerId(withProvenance);
  return { ...withProvenance, header: { ...withProvenance.header, id } };
}

beforeEach(async () => {
  registerLocale(PSEUDO_LOCALE, PSEUDO);
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState({ layerStack: [], collabSelfToken: null });
  const store = await getBrowserLayerStore();
  store.storeLayer(candidateFile());
});

afterEach(() => {
  cleanup();
  setLocale(BASELINE_LOCALE);
});

describe('LayerMergeSection localization (#4918)', () => {
  it('translates the picker labels, preview button, and target-ref option once a candidate exists', async () => {
    const container = render(<LayerMergeSection />);
    await flush();
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'layersPanel.merge.title' },
        { key: 'layersPanel.merge.refreshAriaLabel' },
        { key: 'layersPanel.merge.candidateLayerLabel' },
        { key: 'layersPanel.merge.targetRefLabel' },
        { key: 'layersPanel.merge.previewButton' },
        { key: 'layersPanel.merge.localRefOption', params: { name: DEFAULT_LOCAL_REF } },
      ],
      englishDom,
      afterDom,
    );
  });
});
