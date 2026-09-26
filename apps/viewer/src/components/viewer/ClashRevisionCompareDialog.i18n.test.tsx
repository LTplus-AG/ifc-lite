/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The revision-compare dialog reads the i18n catalogue (#4918 slice:
 * clashrest), covering `ClashRevisionCompareDialog.tsx` — see
 * `clash-tools.en.ts`'s own docblock (`clashTools.revisionCompare.*`).
 *
 * Same oracle as `ClashSettingsDialog.i18n.test.tsx`: a pseudo-locale marks
 * every `clashTools.*` key, the dialog is driven through its no-baseline,
 * baseline-saved, and post-compare (added/persisting/resolved/unretested)
 * states, the locale is switched live, and every marked string visible in
 * English must reappear marked. `warningLines()` is exercised directly too,
 * since #4918 moved it from returning plain strings to `TranslatableMessage`s
 * (labelKey + params) — the same pattern `resolveValidationTarget.ts` uses —
 * so a locale switch retranslates its banner lines like everything else here.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import type { clashToolsEn as ClashToolsEnType } from '@/i18n/catalogues/clash-tools.en';
import { useViewerStore } from '@/store';
import type { Clash, ClashResult } from '@ifc-lite/clash';
import { ClashRevisionCompareDialog, warningLines } from './ClashRevisionCompareDialog.js';

// Guarded dynamic import (#4918 revert-oracle, same pattern as
// ClashSettingsDialog.i18n.test.tsx).
let clashToolsEnLoaded: typeof ClashToolsEnType | undefined;
try {
  ({ clashToolsEn: clashToolsEnLoaded } = await import('@/i18n/catalogues/clash-tools.en'));
} catch {
  clashToolsEnLoaded = undefined;
}
const HAS_CATALOGUE = clashToolsEnLoaded !== undefined;
const CATALOGUE: typeof ClashToolsEnType = clashToolsEnLoaded ?? ({} as typeof ClashToolsEnType);

type ClashToolsKey = keyof typeof CATALOGUE;

function markValue(key: string, value: TranslationValue): TranslationValue {
  if (typeof value === 'string') return `⟦${key}|${value}⟧`;
  const wrapped: Record<string, string> = {};
  for (const [category, text] of Object.entries(value)) wrapped[category] = `⟦${key}|${text}⟧`;
  return wrapped as TranslationValue;
}
const PSEUDO: Catalogue = Object.fromEntries(
  Object.keys(CATALOGUE).map((key) => [key, markValue(key, CATALOGUE[key as ClashToolsKey])]),
);
const PSEUDO_LOCALE = 'clash-revision-compare-pseudo';

function readable(): Set<string> {
  const out = new Set<string>();
  document.body.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const title = element.getAttribute('title');
    if (title) out.add(title);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
  return out;
}

function openDialog(): void {
  render(<ClashRevisionCompareDialog />);
  const trigger = [...document.body.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === CATALOGUE['clashTools.revisionCompare.triggerTooltip'],
  );
  assert.ok(trigger, 'compare trigger button not found');
  click(trigger!);
}

function elementRef(key: string, model: string, tag: string) {
  return { key, ref: Number(key.replace(/\D/g, '')) || 1, model, tag };
}

function makeClash(id: string, aTag: string, bTag: string): Clash {
  return {
    id,
    rule: 'all-clashes',
    status: 'hard',
    distance: -0.05,
    point: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    severity: 'critical',
    a: elementRef(`a-${id}`, 'm1', aTag),
    b: elementRef(`b-${id}`, 'm1', bTag),
  } as Clash;
}

function makeResult(clashes: Clash[]): ClashResult {
  const bySeverity = { critical: clashes.length, major: 0, minor: 0, info: 0 };
  return {
    clashes,
    summary: { total: clashes.length, byRule: {}, byTypePair: {}, bySeverity },
    rulesRun: [],
    ruleCoverage: [],
    settings: { tolerance: 0.005, excludeVoidsAndHosts: true },
  } as unknown as ClashResult;
}

const RESET = { clashResult: null, models: new Map() } as Partial<ReturnType<typeof useViewerStore.getState>>;

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState(RESET);
});

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState(RESET);
});

describe(
  'ClashRevisionCompareDialog localization (#4918)',
  { skip: !HAS_CATALOGUE && 'clash-tools.en.ts catalogue module not present (revert-oracle probe)' },
  () => {
    it('no-baseline state: title, description, empty state, and disabled-button tooltips', () => {
      openDialog();
      const english = readable();
      registerLocale(PSEUDO_LOCALE, PSEUDO);
      act(() => setLocale(PSEUDO_LOCALE));
      const after = readable();

      const keys: ClashToolsKey[] = [
        'clashTools.revisionCompare.triggerTooltip',
        'clashTools.revisionCompare.dialogTitle',
        'clashTools.revisionCompare.dialogDescription',
        'clashTools.revisionCompare.noBaseline',
        'clashTools.revisionCompare.runDetectionFirstTooltip',
        'clashTools.revisionCompare.saveBaselineButton',
      ];
      for (const key of keys) {
        const text = CATALOGUE[key] as string;
        assert.ok(english.has(text), `${key}: "${text}" expected visible in English before switching locale`);
        assert.ok(after.has(`⟦${key}|${text}⟧`), `${key}: must be translated, marked text not found`);
      }
    });

    it('baseline saved + a compared result (added/persisting/resolved/unretested buckets, no-differences state N/A)', () => {
      act(() => useViewerStore.setState({ clashResult: makeResult([makeClash('c1', 'IfcWall', 'IfcDuctSegment')]) }));
      openDialog();

      const saveButton = [...document.body.querySelectorAll('button')].find((b) =>
        b.textContent?.includes(CATALOGUE['clashTools.revisionCompare.saveBaselineButton'] as string),
      );
      assert.ok(saveButton, 'save-current-as-baseline button not found');
      click(saveButton!);

      // Change the result before comparing so the run produces new/persisting/resolved buckets.
      act(() =>
        useViewerStore.setState({
          clashResult: makeResult([
            makeClash('c1', 'IfcWall', 'IfcDuctSegment'), // persists
            makeClash('c2', 'IfcSlab', 'IfcBeam'), // new
          ]),
        }),
      );
      const compareButton = [...document.body.querySelectorAll('button')].find((b) =>
        b.textContent?.trim() === CATALOGUE['clashTools.revisionCompare.compareButton'],
      );
      assert.ok(compareButton, 'compare button not found');
      click(compareButton!);

      const english = readable();
      registerLocale(PSEUDO_LOCALE, PSEUDO);
      act(() => setLocale(PSEUDO_LOCALE));
      const after = readable();

      // Baseline line + bucket titles that must be present for this fixture.
      assert.ok(
        [...english].some((s) => /^Baseline saved /.test(s)),
        'expected the baseline-saved line to render in English first',
      );
      assert.ok(
        [...after].some((s) => s.startsWith('⟦clashTools.revisionCompare.baselineSavedAt|Baseline saved ')),
        'clashTools.revisionCompare.baselineSavedAt: must be translated, marked text not found',
      );
      assert.ok(
        [...after].some((s) => s.includes('⟦clashTools.revisionCompare.clashCount|')),
        'clashTools.revisionCompare.clashCount: must be translated, marked text not found',
      );

      // Each bucket's title shares its DOM text node run with the trailing
      // `(count)` badge (`{title} ({clashes.length})`), so this is a
      // substring check, not exact equality — same reasoning as
      // ClashPanel.i18n.test.tsx's `SUBSTRING_KEYS`.
      const bucketKeys: ClashToolsKey[] = [
        'clashTools.revisionCompare.newBucketTitle',
        'clashTools.revisionCompare.persistingBucketTitle',
      ];
      for (const key of bucketKeys) {
        const text = CATALOGUE[key] as string;
        assert.ok(
          [...english].some((s) => s.includes(text)),
          `${key}: "${text}" expected visible in English before switching locale`,
        );
        assert.ok(
          [...after].some((s) => s.includes(`⟦${key}|${text}⟧`)),
          `${key}: must be translated, marked text not found`,
        );
      }
    });

    it('warningLines() returns TranslatableMessages carrying the rule/model reasons, not plain strings', () => {
      const lines = warningLines({
        added: [],
        persistent: [],
        resolved: [],
        unretested: [makeClash('c1', 'IfcWall', 'IfcDuctSegment')],
        reasons: { skippedRuleIds: ['rule-a'], noMatchRuleIds: [], missingModelNames: [] },
        summary: { added: 0, persistent: 0, resolved: 0, unretested: 1 },
      } as never);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].labelKey, 'clashTools.revisionCompare.skippedRules');
      assert.equal(lines[0].params?.ids, 'rule-a');
    });
  },
);
