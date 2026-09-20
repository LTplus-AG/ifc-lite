/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ZonesPanel`'s own chrome reads the i18n catalogue (#4918 zones slice,
 * `zones-panel.en.ts`): the header, the empty-state hint, the new-set /
 * generate-from-storeys / export-import controls, and (once a set with a
 * zone exists) the per-zone-set count badge and `ZoneRow`'s field labels
 * and action titles. Zone/set NAMES are model/user content and are
 * asserted separately from the catalogue keys, not marked by the
 * pseudo-locale.
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
import type { ZoneSet } from '@/lib/zones';
import { ZonesPanel } from './ZonesPanel.js';

const CATALOGUE: Catalogue = Object.fromEntries(
  Object.entries(en).filter(([key]) => key.startsWith('zonesPanel.') && !key.startsWith('zonesPanel.roomPanel.')),
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
const PSEUDO_LOCALE = 'zones-panel-pseudo';

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

beforeEach(() => {
  registerLocale(PSEUDO_LOCALE, PSEUDO);
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState({ zoneSets: [], editingZone: null, zoneAssignmentTiming: null });
});

afterEach(() => {
  cleanup();
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState({ zoneSets: [], editingZone: null, zoneAssignmentTiming: null });
});

describe('ZonesPanel localization (#4918)', () => {
  it('translates the header, empty state, and the new-set / generate / export-import controls', () => {
    const container = render(<ZonesPanel onClose={() => {}} />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'zonesPanel.header.title' },
        { key: 'zonesPanel.header.newSetPlaceholder' },
        { key: 'zonesPanel.header.addSetButton' },
        { key: 'zonesPanel.header.generateFromStoreysButton' },
        { key: 'zonesPanel.header.exportSetsTitle' },
        { key: 'zonesPanel.header.importSetsTitle' },
        { key: 'zonesPanel.emptyState' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('translates a zone set row, its zone count, and a zone row\'s field labels and controls', () => {
    const zoneSet: ZoneSet = {
      id: 'set-1',
      name: 'Section A',
      visible: true,
      createdAt: 0,
      updatedAt: 0,
      zones: [
        {
          id: 'zone-1',
          name: 'Zone 1',
          center: [0, 1, 0],
          size: [2, 2, 2],
          rotationY: 0,
        },
      ],
    };
    useViewerStore.setState({ zoneSets: [zoneSet] });
    const container = render(<ZonesPanel onClose={() => {}} />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'zonesPanel.zoneCount', params: { count: 1 } },
        { key: 'zonesPanel.hideIn3dTitle' },
        { key: 'zonesPanel.addZoneTitle' },
        { key: 'zonesPanel.deleteZoneSetTitle' },
        { key: 'zonesPanel.setNamePlaceholder' },
        { key: 'zonesPanel.zoneRow.editIn3dTitle' },
        { key: 'zonesPanel.zoneRow.selectTitle' },
        { key: 'zonesPanel.zoneRow.exportGeometryTitle' },
        { key: 'zonesPanel.zoneRow.exportGeometryAriaLabel', params: { name: 'Zone 1' } },
        { key: 'zonesPanel.zoneRow.deleteZoneTitle' },
        { key: 'zonesPanel.zoneRow.centerXLabel' },
        { key: 'zonesPanel.zoneRow.centerYLabel' },
        { key: 'zonesPanel.zoneRow.centerZLabel' },
        { key: 'zonesPanel.zoneRow.widthLabel' },
        { key: 'zonesPanel.zoneRow.heightLabel' },
        { key: 'zonesPanel.zoneRow.depthLabel' },
        { key: 'zonesPanel.zoneRow.rotationLabel' },
      ],
      englishDom,
      afterDom,
    );
    // The set and zone NAMES are user content, not catalogue keys — they must
    // stay literal through the locale switch. The set name renders as text;
    // the zone name is a controlled `<Input>`, so read its `.value` directly
    // rather than scanning text nodes.
    assert.ok(englishDom.has('Section A'), 'the set name must render as-is');
    assert.ok(afterDom.has('Section A'), 'the set name must not be marked by the pseudo-locale');
    const zoneNameInput = container.querySelector('input[value="Zone 1"]') as HTMLInputElement | null;
    assert.ok(zoneNameInput, 'the zone name input must render the zone name as-is');
    act(() => setLocale(PSEUDO_LOCALE));
    try {
      assert.equal(zoneNameInput!.value, 'Zone 1', 'the zone name input must not be marked by the pseudo-locale');
    } finally {
      act(() => setLocale(BASELINE_LOCALE));
    }
  });

  it('translates the last-assignment timing footer', () => {
    useViewerStore.setState({
      zoneAssignmentTiming: { elapsedMs: 12.3, elementCount: 42, zoneSetCount: 2, computedAt: 0 },
    });
    const container = render(<ZonesPanel onClose={() => {}} />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        {
          key: 'zonesPanel.assignmentTimingLine',
          params: { elementCount: (42).toLocaleString(), zoneSetCount: 2, elapsedMs: '12.3' },
        },
      ],
      englishDom,
      afterDom,
    );
  });
});
