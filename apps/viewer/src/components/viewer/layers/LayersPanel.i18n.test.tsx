/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `LayersPanel`'s own chrome reads the i18n catalogue (#4918 layers slice,
 * `layers-panel.en.ts`): the empty-state hero copy, and the loaded-stack
 * header, per-stratum labels, and author badges. Layer NAMES are model
 * content and stay literal — they are asserted separately from the
 * catalogue keys, not marked by the pseudo-locale.
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
import type { LayerStackEntry } from '@/store/slices/layerStackSlice';
import type { IfcxFile } from '@ifc-lite/ifcx';
import { LayersPanel } from './LayersPanel.js';

const CATALOGUE: Catalogue = Object.fromEntries(
  Object.entries(en).filter(([key]) => key.startsWith('layersPanel.panel.')),
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
const PSEUDO_LOCALE = 'layers-panel-pseudo';

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

/** `LayersPanel` always mounts `LayerMergeSection`, whose own effect
 *  refreshes candidates from the (async) browser layer store; flush that
 *  microtask under `act()` so its state settles before assertions run. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const FAKE_FILE = {
  header: { id: 'blake3:x', ifcxVersion: '1', dataVersion: '1', author: 'test', timestamp: '2026-09-20T00:00:00Z' },
  imports: [],
  schemas: {},
  data: [],
} as IfcxFile;

beforeEach(() => {
  registerLocale(PSEUDO_LOCALE, PSEUDO);
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState({
    layerStack: [],
    layerStackDiff: null,
    layerDiffBusy: false,
    layerStackPathToId: null,
  });
});

afterEach(() => {
  cleanup();
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState({
    layerStack: [],
    layerStackDiff: null,
    layerDiffBusy: false,
    layerStackPathToId: null,
  });
});

describe('LayersPanel localization (#4918)', () => {
  it('translates the empty-state hero copy and its buttons', async () => {
    const container = render(<LayersPanel onClose={() => {}} />);
    await flush();
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'layersPanel.panel.heroTitle' },
        { key: 'layersPanel.panel.heroDescription' },
        { key: 'layersPanel.panel.loadDemoStack' },
        { key: 'layersPanel.panel.openFilesButton' },
        { key: 'layersPanel.panel.dropHint' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('translates the loaded-stack header, stratum chrome, and unsigned badge', async () => {
    const entry: LayerStackEntry = {
      id: 'layer-1',
      name: 'base.ifcx',
      file: FAKE_FILE,
      nodeCount: 12,
      byteLength: 100,
      checksPassed: 2,
      checksTotal: 2,
    };
    useViewerStore.setState({ layerStack: [entry] });
    const container = render(<LayersPanel onClose={() => {}} />);
    await flush();
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'layersPanel.panel.layerCountHeader', params: { count: 1, countDisplay: '1' } },
        { key: 'layersPanel.panel.nodeCount', params: { count: 12, countDisplay: '12' } },
        { key: 'layersPanel.panel.unsigned' },
        { key: 'layersPanel.panel.checksBadge', params: { passed: 2, total: 2 } },
        { key: 'layersPanel.panel.changesButton' },
        { key: 'layersPanel.panel.provenanceAriaLabel', params: { name: 'base.ifcx' } },
      ],
      englishDom,
      afterDom,
    );
    // The layer NAME itself is model content, not a catalogue key — it must
    // stay literal through the locale switch.
    assert.ok(englishDom.has('base.ifcx'), 'the layer name must render as-is');
    assert.ok(afterDom.has('base.ifcx'), 'the layer name must not be marked by the pseudo-locale');
  });

  it('translates the author badge for a signed human layer', async () => {
    const entry: LayerStackEntry = {
      id: 'layer-2',
      name: 'authored.ifcx',
      file: FAKE_FILE,
      nodeCount: 3,
      byteLength: 50,
      authorKind: 'human',
      authorPrincipal: 'louis@lt.plus',
    };
    useViewerStore.setState({ layerStack: [entry] });
    const container = render(<LayersPanel onClose={() => {}} />);
    await flush();
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate([{ key: 'layersPanel.panel.authorHuman' }], englishDom, afterDom);
  });
});
