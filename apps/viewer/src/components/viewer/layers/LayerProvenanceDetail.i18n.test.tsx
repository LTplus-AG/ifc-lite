/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `LayerProvenanceDetail`'s own chrome reads the i18n catalogue (#4918
 * layers slice, `layers-panel.en.ts`).
 *
 * The oracle is a pseudo-locale that marks every `layersPanel.*` key with a
 * `⟦…⟧` wrapper; the real English text (computed through `resolve()`, never
 * hardcoded here) must be on screen before the switch, and the marked form
 * must reappear after it. Manifest data itself (author principal, intent
 * text, base id, scope claims) is runtime content and stays literal by
 * design — it is asserted separately from the catalogue keys.
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
import { setProvenance, PROVENANCE_KEY } from '@ifc-lite/ifcx';
import type { IfcxFile, ProvenanceManifest } from '@ifc-lite/ifcx';
import { LayerProvenanceDetail } from './LayerProvenanceDetail.js';

const CATALOGUE: Catalogue = Object.fromEntries(
  Object.entries(en).filter(([key]) => key.startsWith('layersPanel.provenance.') || key.startsWith('layersPanel.checkEvidence.')),
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
const PSEUDO_LOCALE = 'layers-provenance-pseudo';

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

// `readableStrings` trims each direct text node, so a template with
// deliberate leading/trailing whitespace (e.g. a mid-sentence connector
// rendered as its own text node) must be trimmed the same way to compare.
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

function baseManifest(overrides: Partial<ProvenanceManifest> = {}): ProvenanceManifest {
  return {
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
    ...overrides,
  };
}

function fileWith(manifest: ProvenanceManifest): IfcxFile {
  const file: IfcxFile = {
    header: { id: 'blake3:test', ifcxVersion: '1', dataVersion: '1', author: 'test', timestamp: '2026-09-20T00:00:00Z' },
    imports: [],
    schemas: {},
    data: [],
  };
  return setProvenance(file, manifest);
}

beforeEach(() => {
  registerLocale(PSEUDO_LOCALE, PSEUDO);
  setLocale(BASELINE_LOCALE);
});

afterEach(() => {
  cleanup();
  setLocale(BASELINE_LOCALE);
});

describe('LayerProvenanceDetail localization (#4918)', () => {
  it('translates the unsigned (no manifest) state', () => {
    const file: IfcxFile = {
      header: { id: 'blake3:raw', ifcxVersion: '1', dataVersion: '1', author: 'test', timestamp: '2026-09-20T00:00:00Z' },
      imports: [],
      schemas: {},
      data: [],
    };
    const container = render(<LayerProvenanceDetail file={file} />);
    const englishDom = readableStrings(container);
    act(() => setLocale(PSEUDO_LOCALE));
    const afterDom = readableStrings(container);
    act(() => setLocale(BASELINE_LOCALE));
    assertAllTranslate([{ key: 'layersPanel.provenance.noManifest' }], englishDom, afterDom);
  });

  it('translates every field label and the base/scope/checks fallbacks for a minimal manifest', () => {
    const file = fileWith(baseManifest());
    const container = render(<LayerProvenanceDetail file={file} />);
    const englishDom = readableStrings(container);
    const occurrences: Occurrence[] = [
      { key: 'layersPanel.provenance.authorField' },
      { key: 'layersPanel.provenance.intentField' },
      { key: 'layersPanel.provenance.createdField' },
      { key: 'layersPanel.provenance.baseField' },
      { key: 'layersPanel.provenance.scopeField' },
      { key: 'layersPanel.provenance.checksField' },
      { key: 'layersPanel.provenance.authorLine', params: { kind: 'human', principal: 'louis@lt.plus' } },
      { key: 'layersPanel.provenance.baseNone' },
      { key: 'layersPanel.provenance.scopeUnrestricted' },
      { key: 'layersPanel.provenance.checksNoneAttached' },
    ];
    const afterDom = (() => {
      act(() => setLocale(PSEUDO_LOCALE));
      const set = readableStrings(container);
      act(() => setLocale(BASELINE_LOCALE));
      return set;
    })();
    assertAllTranslate(occurrences, englishDom, afterDom);
  });

  it('translates the malformed-manifest message and the merge/identity/signature counts', () => {
    const malformedFile = fileWith({ ...baseManifest(), v: 1 });
    // Corrupt AFTER setProvenance (which validates on write) so the read path exercises the malformed branch.
    (malformedFile.header as unknown as Record<string, unknown>)[PROVENANCE_KEY] = {
      ...baseManifest(),
      author: undefined,
    };
    const malformedContainer = render(<LayerProvenanceDetail file={malformedFile} />);
    let englishDom = readableStrings(malformedContainer);
    let afterDom = (() => {
      act(() => setLocale(PSEUDO_LOCALE));
      const set = readableStrings(malformedContainer);
      act(() => setLocale(BASELINE_LOCALE));
      return set;
    })();
    assertAllTranslate(
      [{ key: 'layersPanel.provenance.malformedManifest', params: { count: 1, countDisplay: '1' } }],
      englishDom,
      afterDom,
    );

    const mergedFile = fileWith(
      baseManifest({
        merge: {
          candidate: 'blake3:candidate',
          into: 'main',
          resolver: 'louis@lt.plus',
          resolutions: [{ entity: '/wall', choice: 'ours' }],
          waived_checks: [{ spec: 'ids:fire', reason: 'accepted risk', waivedBy: 'louis@lt.plus' }],
        },
        identity_map: [{ base: '/a', here: '/a', reason: 'derived' }],
        signatures: [{ alg: 'ed25519', key: 'louis@lt.plus', sig: 'abc' }],
      }),
    );
    const mergedContainer = render(<LayerProvenanceDetail file={mergedFile} />);
    englishDom = readableStrings(mergedContainer);
    afterDom = (() => {
      act(() => setLocale(PSEUDO_LOCALE));
      const set = readableStrings(mergedContainer);
      act(() => setLocale(BASELINE_LOCALE));
      return set;
    })();
    assertAllTranslate(
      [
        { key: 'layersPanel.provenance.mergeField' },
        { key: 'layersPanel.provenance.identityField' },
        { key: 'layersPanel.provenance.signedField' },
        { key: 'layersPanel.provenance.mergeIntoBy', params: { into: 'main', resolver: 'louis@lt.plus' } },
        { key: 'layersPanel.provenance.identityCount', params: { count: 1, countDisplay: '1' } },
        { key: 'layersPanel.provenance.signaturesCount', params: { count: 1, countDisplay: '1' } },
      ],
      englishDom,
      afterDom,
    );

    // `resolutionsCount` and `waivedCountSuffix` render as two adjacent JSX
    // expression children of the same <span>, so `readableStrings` joins
    // them into one combined text node rather than two separately readable
    // strings — assert the combined line instead of each key alone.
    const combinedResolutionsLine =
      resolve('layersPanel.provenance.resolutionsCount' as never, { count: 1, countDisplay: '1' }) +
      resolve('layersPanel.provenance.waivedCountSuffix' as never, { count: 1, countDisplay: '1' });
    assert.ok(englishDom.has(combinedResolutionsLine.trim()), 'expected the combined resolutions/waived line in English');
    act(() => setLocale(PSEUDO_LOCALE));
    const combinedPseudoLine =
      resolve('layersPanel.provenance.resolutionsCount' as never, { count: 1, countDisplay: '1' }) +
      resolve('layersPanel.provenance.waivedCountSuffix' as never, { count: 1, countDisplay: '1' });
    act(() => setLocale(BASELINE_LOCALE));
    assert.ok(
      afterDom.has(combinedPseudoLine.trim()),
      'expected the combined resolutions/waived line to be translated',
    );
  });
});
