/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The clash settings dialog reads the i18n catalogue (#4918 slice:
 * clashrest), covering `ClashSettingsDialog.tsx` — see `clash-tools.en.ts`'s
 * own docblock for the exact surface (`clashTools.settings.*`).
 *
 * Same oracle as `ClashPanel.i18n.test.tsx`: a pseudo-locale maps every
 * `clashTools.*` key to a marked copy of its English text, the dialog is
 * driven open (trigger click) through both tabs, the locale is switched
 * live, and every marked string that was visible in English must reappear
 * marked. The dialog content renders through a Radix portal appended to
 * `document.body`, not into the container `render()` returns, so every
 * query below reads `document.body`.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import type { clashToolsEn as ClashToolsEnType } from '@/i18n/catalogues/clash-tools.en';
import { ClashSettingsDialog } from './ClashSettingsDialog.js';

// Guarded dynamic import (#4918 revert-oracle, same pattern as
// ClashPanel.i18n.test.tsx): a revert of this slice's production change
// deletes clash-tools.en.ts entirely, and a static `import { clashToolsEn }
// from '...'` would fail this file's whole LOAD (ERR_MODULE_NOT_FOUND)
// rather than let the assertions below fail on their own merits.
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
const PSEUDO_LOCALE = 'clash-settings-pseudo';

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
  render(<ClashSettingsDialog />);
  const trigger = [...document.body.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === CATALOGUE['clashTools.settings.title'],
  );
  assert.ok(trigger, 'settings trigger button not found');
  click(trigger!);
}

/**
 * Radix `Tabs.Trigger` switches on `onMouseDown` (button===0, no ctrlKey),
 * not `onClick` — `click()`'s bubbling `MouseEvent('click', …)` alone never
 * fires it, so a plain `click()` here would silently leave the Detection
 * tab mounted.
 */
function clickTab(name: string): void {
  const tab = [...document.body.querySelectorAll('button[role="tab"]')].find((b) => b.textContent?.trim() === name);
  assert.ok(tab, `tab "${name}" not found`);
  act(() => {
    tab!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  });
}

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

/**
 * Keys not shown by either state exercised in this suite. Radix `Select`
 * only mounts its `SelectItem`s into the DOM while the popover is open —
 * closed, only the current selection's text renders (via `SelectValue`) —
 * so the non-default options of the mode / grouping selects never reach the
 * DOM here. `clashTools.settings.modeHard` and `.groupBySeverity` (the
 * defaults) are still asserted below.
 */
const NOT_RENDERED: ClashToolsKey[] = [
  'clashTools.settings.modeClearance',
  'clashTools.settings.groupByRule',
  'clashTools.settings.groupByTypePair',
];

describe(
  'ClashSettingsDialog localization (#4918)',
  { skip: !HAS_CATALOGUE && 'clash-tools.en.ts catalogue module not present (revert-oracle probe)' },
  () => {
    it('Detection tab: title, summary, every setting row, and the reset button', () => {
      openDialog();
      const english = readable();
      registerLocale(PSEUDO_LOCALE, PSEUDO);
      act(() => setLocale(PSEUDO_LOCALE));
      const after = readable();

      const detectionKeys: ClashToolsKey[] = [
        'clashTools.settings.title',
        'clashTools.settings.detectionTab',
        'clashTools.settings.rulesTab',
        'clashTools.settings.modeLabel',
        'clashTools.settings.modeHint',
        'clashTools.settings.toleranceLabel',
        'clashTools.settings.toleranceHint',
        'clashTools.settings.clearanceGapLabel',
        'clashTools.settings.clearanceGapHint',
        'clashTools.settings.duplicateToleranceLabel',
        'clashTools.settings.duplicateToleranceHint',
        'clashTools.settings.clusterRadiusLabel',
        'clashTools.settings.clusterRadiusHint',
        'clashTools.settings.reportTouchLabel',
        'clashTools.settings.reportTouchHint',
        'clashTools.settings.showRegionBoxLabel',
        'clashTools.settings.showRegionBoxHint',
        'clashTools.settings.groupingLabel',
        'clashTools.settings.groupingHint',
        'clashTools.settings.modeHard',
        'clashTools.settings.modeClearance',
        'clashTools.settings.groupBySeverity',
        'clashTools.settings.groupByRule',
        'clashTools.settings.groupByTypePair',
        'clashTools.settings.resetDetectionButton',
      ];
      for (const key of detectionKeys) {
        if (NOT_RENDERED.includes(key)) continue;
        const text = CATALOGUE[key] as string;
        assert.ok(english.has(text), `${key}: "${text}" expected visible in English before switching locale`);
        assert.ok(after.has(`⟦${key}|${text}⟧`), `${key}: must be translated, marked text not found`);
      }
      // Summary line interpolates {enabled}/{total} — the default preset set
      // ships with every built-in rule enabled, so "N of N rules enabled."
      assert.ok(
        [...after].some((s) => /⟦clashTools\.settings\.summary\|.*of \d+ rules enabled\.⟧/.test(s)),
        'expected the interpolated summary line to render marked',
      );
    });

    it('Rules tab: add/reset/export/import controls, a built-in rule row, and its custom badge', () => {
      openDialog();
      clickTab('Rules');

      // Add a custom rule so the "custom" badge has something to attach to.
      const addButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes('Add rule'));
      assert.ok(addButton, 'Add rule button not found');
      click(addButton!);
      const nameInput = [...document.body.querySelectorAll('input')].find(
        (i) => i.getAttribute('placeholder') === CATALOGUE['clashTools.ruleEditor.namePlaceholder'],
      ) as HTMLInputElement | undefined;
      assert.ok(nameInput, 'rule name input not found');
      const selectorAInput = [...document.body.querySelectorAll('input')].find(
        (i) => i.getAttribute('placeholder') === CATALOGUE['clashTools.ruleEditor.selectorAPlaceholder'],
      ) as HTMLInputElement | undefined;
      const selectorBInput = [...document.body.querySelectorAll('input')].find(
        (i) => i.getAttribute('placeholder') === CATALOGUE['clashTools.ruleEditor.selectorBPlaceholder'],
      ) as HTMLInputElement | undefined;
      assert.ok(selectorAInput && selectorBInput, 'rule selector inputs not found');
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      act(() => {
        setValue.call(nameInput, 'Ducts vs Beams');
        nameInput!.dispatchEvent(new window.Event('input', { bubbles: true }));
        setValue.call(selectorAInput, 'IfcDuctSegment');
        selectorAInput!.dispatchEvent(new window.Event('input', { bubbles: true }));
        setValue.call(selectorBInput, 'IfcBeam');
        selectorBInput!.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      const saveButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === CATALOGUE['clashTools.ruleEditor.addButton']);
      assert.ok(saveButton, 'save/add button not found');
      click(saveButton!);

      const english = readable();
      registerLocale(PSEUDO_LOCALE, PSEUDO);
      act(() => setLocale(PSEUDO_LOCALE));
      const after = readable();

      const rulesKeys: ClashToolsKey[] = [
        'clashTools.settings.addRuleButton',
        'clashTools.settings.resetRulesTooltip',
        'clashTools.settings.exportRulesTooltip',
        'clashTools.settings.importRulesTooltip',
        'clashTools.settings.customBadge',
        'clashTools.settings.editTooltip',
        'clashTools.settings.deleteTooltip',
      ];
      for (const key of rulesKeys) {
        if (NOT_RENDERED.includes(key)) continue;
        const text = CATALOGUE[key] as string;
        assert.ok(english.has(text), `${key}: "${text}" expected visible in English before switching locale`);
        assert.ok(after.has(`⟦${key}|${text}⟧`), `${key}: must be translated, marked text not found`);
      }
    });
  },
);
