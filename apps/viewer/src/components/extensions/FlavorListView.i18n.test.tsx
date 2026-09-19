/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FlavorListView`'s own chrome reads the i18n catalogue (#4918 sweep,
 * `extensions-flavors.en.ts`).
 *
 * `extensionsFlavorsEn` is not wired into `en.ts` yet (a later, central
 * integration step does that once every #4918 worktree lands, to avoid
 * every parallel slice conflicting on the same import list) — so `resolve()`
 * cannot fall back to the real `'en'` locale for these keys. Instead this
 * oracle registers the real English text under its OWN locale id
 * (`BASELINE_LOCALE`) and renders against that instead of literal `'en'`,
 * then switches to a pseudo-locale that marks each string and asserts the
 * marked form reappears live. Expected text for every occurrence — plain
 * or interpolated, including the plural `nameSnapshotLabel` /
 * `uncapturedTitle` keys — is computed through the real `resolve()`, so the
 * assertions never hardcode a copy of the English source text.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render, click } from '@/test/render.js';
import { registerLocale, setLocale } from '@/i18n';
import type { Catalogue } from '@/i18n';
import { resolve } from '@/i18n/registry';
import { extensionsFlavorsEn } from '@/i18n/catalogues/extensions-flavors.en';
import type { TranslationValue, PluralTranslation, TranslationParameters } from '@/i18n';
import { DEFAULT_FLAVOR_ID, type Flavor } from '@ifc-lite/extensions';
import {
  DEFAULT_FLAVOR_DESCRIPTION,
  DEFAULT_FLAVOR_NAME,
} from '@/services/extensions/default-flavor-metadata';
import { FlavorListView } from './FlavorListView.js';

// `resolve()` is typed against the real (wired-in) `TranslationKey` union;
// these keys aren't part of it yet (see file header), so calls go through
// an untyped alias rather than fighting the type system over a gap the
// integration step closes later.
const r = resolve as unknown as (key: string, params?: TranslationParameters) => string;

const BASELINE_LOCALE = 'extensions-flavors-en-baseline';
const PSEUDO_LOCALE = 'extensions-flavors-pseudo';

function markValue(value: TranslationValue): TranslationValue {
  if (typeof value === 'string') return `⟦${value}⟧`;
  const marked: Record<string, string> = {};
  for (const [category, text] of Object.entries(value as PluralTranslation)) {
    if (typeof text === 'string') marked[category] = `⟦${text}⟧`;
  }
  return marked as PluralTranslation;
}

const KEYS = Object.keys(extensionsFlavorsEn) as (keyof typeof extensionsFlavorsEn)[];
const PSEUDO: Catalogue = Object.fromEntries(
  KEYS.map((key) => [key, markValue(extensionsFlavorsEn[key])]),
) as Catalogue;

/** aria-label, title, placeholder attributes, and direct text-node content
 *  of every element — every surface `FlavorListView` renders its own copy
 *  through (no Radix Tooltip in this component: `title` is a plain HTML
 *  attribute, always in the DOM, no focus/hover needed to read it). */
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

function makeFlavor(overrides: Partial<Flavor>): Flavor {
  return {
    schemaVersion: 1,
    id: 'flv.x',
    name: 'X',
    description: '',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    extensions: [],
    lenses: [],
    savedQueries: [],
    keybindings: [],
    layout: { state: {} },
    settings: {},
    ...overrides,
  } as Flavor;
}

const flavorA = makeFlavor({
  id: 'flv.a',
  name: 'Alpha',
  lenses: [{ id: 'l1', name: 'Lens1', definition: {} }] as unknown as Flavor['lenses'],
});
const flavorB = makeFlavor({ id: 'flv.b', name: 'Beta' });
const dateA = new Date(flavorA.updatedAt).toLocaleDateString();
const dateB = new Date(flavorB.updatedAt).toLocaleDateString();

const noop = () => {};

function baseProps() {
  return {
    flavors: [flavorA, flavorB],
    activeId: 'flv.a',
    busy: false,
    liveLensCount: 2, // > flavorA.lenses.length (1) so flv.a shows "uncaptured"
    onActivate: noop,
    onExport: noop,
    onDelete: noop,
    onImportClick: noop,
    onReset: noop,
    onCaptureInto: noop,
    onRename: noop,
    onDuplicate: noop,
    onCreate: noop,
  };
}

/** `(key, params)` pairs actually exercised by a render + interaction
 *  sequence. Deduped on `key + JSON(params)` since the same key legitimately
 *  appears more than once with different interpolated values (per-row
 *  aria-labels). */
interface Occurrence {
  key: string;
  params?: TranslationParameters;
}

function assertAllTranslate(occurrences: Occurrence[], englishDom: Set<string>, afterDom: Set<string>): void {
  const seen = new Set<string>();
  for (const occ of occurrences) {
    const dedupeKey = `${occ.key}|${JSON.stringify(occ.params ?? {})}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const english = r(occ.key, occ.params);
    assert.ok(
      englishDom.has(english),
      `${occ.key}: expected English text ${JSON.stringify(english)} to be on screen before the locale switch`,
    );
  }
  act(() => setLocale(PSEUDO_LOCALE));
  try {
    for (const dedupeKeyRaw of seen) {
      const [key] = dedupeKeyRaw.split('|');
      const occ = occurrences.find((o) => `${o.key}|${JSON.stringify(o.params ?? {})}` === dedupeKeyRaw)!;
      const pseudo = r(occ.key, occ.params);
      assert.ok(
        afterDom.has(pseudo),
        `${key}: "${pseudo}" must be translated, marked text not found in the switched-locale DOM`,
      );
    }
  } finally {
    // Leave the registry back on the baseline: callers build their next
    // `Occurrence[]` batch (and click on English button text) assuming it.
    act(() => setLocale(BASELINE_LOCALE));
  }
}

beforeEach(() => {
  registerLocale(BASELINE_LOCALE, extensionsFlavorsEn as Catalogue);
  registerLocale(PSEUDO_LOCALE, PSEUDO);
  setLocale(BASELINE_LOCALE);
});

afterEach(() => {
  cleanup();
  setLocale(BASELINE_LOCALE);
});

describe('FlavorListView localization (#4918)', () => {
  it('localizes only untouched default metadata and preserves user edits', () => {
    const baseline = makeFlavor({
      id: DEFAULT_FLAVOR_ID,
      name: DEFAULT_FLAVOR_NAME,
      description: DEFAULT_FLAVOR_DESCRIPTION,
    });
    const container = render(<FlavorListView {...baseProps()} flavors={[baseline]} />);
    act(() => setLocale(PSEUDO_LOCALE));

    assert.match(
      container.textContent ?? '',
      new RegExp(r('extensionsFlavors.flavorIndicator.defaultLabel').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.match(
      container.textContent ?? '',
      new RegExp(r('extensionsFlavors.flavorIndicator.defaultDescription').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );

    cleanup();
    const renamed = { ...baseline, name: 'My baseline', description: 'My description' };
    const renamedContainer = render(<FlavorListView {...baseProps()} flavors={[renamed]} />);
    assert.match(renamedContainer.textContent ?? '', /My baseline/);
    assert.match(renamedContainer.textContent ?? '', /My description/);
    assert.doesNotMatch(
      renamedContainer.textContent ?? '',
      new RegExp(r('extensionsFlavors.flavorIndicator.defaultLabel').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });

  it('translates the default list + row chrome, including per-row interpolated names', () => {
    const container = render(<FlavorListView {...baseProps()} />);
    const englishDom = readableStrings(container);

    const occurrences: Occurrence[] = [
      { key: 'extensionsFlavors.flavorListView.intro' },
      { key: 'extensionsFlavors.flavorListView.saveCurrentAriaLabel' },
      { key: 'extensionsFlavors.flavorListView.saveCurrentLabel' },
      { key: 'extensionsFlavors.flavorListView.importButton' },
      { key: 'extensionsFlavors.flavorListView.resetTitle' },
      { key: 'extensionsFlavors.flavorListView.resetButton' },
      { key: 'extensionsFlavors.flavorListView.renameAriaLabel', params: { name: 'Alpha' } },
      { key: 'extensionsFlavors.flavorListView.clickToRenameTitle' },
      { key: 'extensionsFlavors.flavorListView.activeBadge' },
      { key: 'extensionsFlavors.flavorListView.uncapturedTitle', params: { count: 1 } },
      { key: 'extensionsFlavors.flavorListView.uncapturedBadge', params: { count: 1 } },
      {
        key: 'extensionsFlavors.flavorListView.statsLine',
        params: { ext: 0, lens: 1, qry: 0, clash: 0, date: dateA },
      },
      { key: 'extensionsFlavors.flavorListView.captureAriaLabel', params: { name: 'Alpha' } },
      {
        key: 'extensionsFlavors.flavorListView.captureTitleUncaptured',
        params: { name: 'Alpha', count: 1 },
      },
      { key: 'extensionsFlavors.flavorListView.renameTitle' },
      { key: 'extensionsFlavors.flavorListView.duplicateAriaLabel', params: { name: 'Alpha' } },
      { key: 'extensionsFlavors.flavorListView.duplicateTitle' },
      { key: 'extensionsFlavors.flavorListView.exportAriaLabel', params: { name: 'Alpha' } },
      { key: 'extensionsFlavors.flavorListView.exportTitle' },
      { key: 'extensionsFlavors.flavorListView.renameAriaLabel', params: { name: 'Beta' } },
      {
        key: 'extensionsFlavors.flavorListView.statsLine',
        params: { ext: 0, lens: 0, qry: 0, clash: 0, date: dateB },
      },
      { key: 'extensionsFlavors.flavorListView.captureAriaLabel', params: { name: 'Beta' } },
      { key: 'extensionsFlavors.flavorListView.captureTitleSnapshot', params: { name: 'Beta' } },
      { key: 'extensionsFlavors.flavorListView.duplicateAriaLabel', params: { name: 'Beta' } },
      { key: 'extensionsFlavors.flavorListView.exportAriaLabel', params: { name: 'Beta' } },
      { key: 'extensionsFlavors.flavorListView.deleteAriaLabel', params: { name: 'Beta' } },
      { key: 'extensionsFlavors.flavorListView.deleteTitle' },
      { key: 'extensionsFlavors.flavorListView.activateButton' },
    ];

    const afterDom = (() => {
      act(() => setLocale(PSEUDO_LOCALE));
      const set = readableStrings(container);
      act(() => setLocale(BASELINE_LOCALE));
      return set;
    })();

    assertAllTranslate(occurrences, englishDom, afterDom);
  });

  it('translates the inline create-flavor form, in both snapshot and empty mode', () => {
    const container = render(<FlavorListView {...baseProps()} />);

    // Opens in "snapshot" mode: liveLensCount (2) > 0.
    const saveCurrent = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === r('extensionsFlavors.flavorListView.saveCurrentLabel'),
    );
    assert.ok(saveCurrent, 'the header create-flavor trigger must render');
    click(saveCurrent!);

    let englishDom = readableStrings(container);
    const snapshotOccurrences: Occurrence[] = [
      { key: 'extensionsFlavors.flavorListView.nameSnapshotLabel', params: { count: 2 } },
      { key: 'extensionsFlavors.flavorListView.placeholderSnapshot' },
      { key: 'extensionsFlavors.flavorListView.switchToEmptyTitle' },
      { key: 'extensionsFlavors.flavorListView.modeLabelSnapshot' },
      { key: 'extensionsFlavors.flavorListView.createButton' },
      { key: 'extensionsFlavors.flavorListView.cancelButton' },
    ];
    let afterDom = (() => {
      act(() => setLocale(PSEUDO_LOCALE));
      const set = readableStrings(container);
      act(() => setLocale(BASELINE_LOCALE));
      return set;
    })();
    assertAllTranslate(snapshotOccurrences, englishDom, afterDom);

    // Flip to "empty" mode via the toggle button.
    const toggle = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === r('extensionsFlavors.flavorListView.modeLabelSnapshot'),
    );
    assert.ok(toggle, 'the snapshot/empty toggle must render');
    click(toggle!);

    englishDom = readableStrings(container);
    const emptyOccurrences: Occurrence[] = [
      { key: 'extensionsFlavors.flavorListView.nameEmptyLabel' },
      { key: 'extensionsFlavors.flavorListView.placeholderEmpty' },
      { key: 'extensionsFlavors.flavorListView.switchToSnapshotTitle' },
      { key: 'extensionsFlavors.flavorListView.modeLabelEmpty' },
    ];
    afterDom = (() => {
      act(() => setLocale(PSEUDO_LOCALE));
      const set = readableStrings(container);
      act(() => setLocale(BASELINE_LOCALE));
      return set;
    })();
    assertAllTranslate(emptyOccurrences, englishDom, afterDom);
  });

  it('translates the inline rename controls once a row enters rename mode', () => {
    const container = render(<FlavorListView {...baseProps()} />);
    const renameButtons = [...container.querySelectorAll('button')].filter(
      (b) => b.getAttribute('aria-label') === r('extensionsFlavors.flavorListView.renameAriaLabel', { name: 'Beta' }),
    );
    assert.ok(renameButtons.length > 0, 'a Rename icon button for Beta must render');
    click(renameButtons[renameButtons.length - 1]);

    const englishDom = readableStrings(container);
    const occurrences: Occurrence[] = [
      { key: 'extensionsFlavors.flavorListView.saveNameAriaLabel' },
      { key: 'extensionsFlavors.flavorListView.cancelRenameAriaLabel' },
    ];
    const afterDom = (() => {
      act(() => setLocale(PSEUDO_LOCALE));
      const set = readableStrings(container);
      act(() => setLocale(BASELINE_LOCALE));
      return set;
    })();
    assertAllTranslate(occurrences, englishDom, afterDom);
  });

  it('translates the "New flavor" (no live lenses) and empty-list states', () => {
    // liveLensCount = 0: the header trigger switches to "New flavor" / "Create a new empty flavor".
    const withLenses = render(
      <FlavorListView {...baseProps()} liveLensCount={0} />,
    );
    let englishDom = readableStrings(withLenses);
    let afterDom = (() => {
      act(() => setLocale(PSEUDO_LOCALE));
      const set = readableStrings(withLenses);
      act(() => setLocale(BASELINE_LOCALE));
      return set;
    })();
    assertAllTranslate(
      [
        { key: 'extensionsFlavors.flavorListView.createNewAriaLabel' },
        { key: 'extensionsFlavors.flavorListView.newFlavorLabel' },
      ],
      englishDom,
      afterDom,
    );

    // No flavors at all: the empty-state sentence, composed from three
    // already-translated sub-strings (`newFlavor` / `reset` / `import`).
    const empty = render(<FlavorListView {...baseProps()} flavors={[]} />);
    const composeEmptyState = () =>
      r('extensionsFlavors.flavorListView.emptyState', {
        newFlavor: r('extensionsFlavors.flavorListView.newFlavorLabel'),
        reset: r('extensionsFlavors.flavorListView.resetButton'),
        import: r('extensionsFlavors.flavorListView.importButton'),
      });
    const englishEmptyState = composeEmptyState();
    englishDom = readableStrings(empty);
    assert.ok(englishDom.has(englishEmptyState), 'the empty-state sentence must render in English');

    act(() => setLocale(PSEUDO_LOCALE));
    const pseudoEmptyState = composeEmptyState();
    afterDom = readableStrings(empty);
    act(() => setLocale(BASELINE_LOCALE));
    assert.ok(
      afterDom.has(pseudoEmptyState),
      'the empty-state sentence must be translated, marked text not found',
    );
  });
});
