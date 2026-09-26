/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ListResultsTable` / `ListScheduleTable` / `ListGroupingBar` /
 * `ColumnHeaderMenu` localization (#4918 lists slice) — the
 * `lists.resultsTable.*`, `lists.scheduleTable.*`, `lists.groupingBar.*` and
 * `lists.columnMenu.*` keys of `apps/viewer/src/i18n/catalogues/lists.en.ts`.
 * `ListPanel`/`ListLibrary`/`ListModelTagScopeEditor`/`ListErrorBox` and
 * `ListBuilder` are covered by the sibling `Lists.i18n.test.tsx` and
 * `ListBuilder.i18n.test.tsx` files instead.
 *
 * `en` doesn't carry the lists catalogue yet (the whole #4918 sweep's
 * integration pass wires it into `apps/viewer/src/i18n/en.ts`) — `en` is a
 * plain, non-frozen object, so `Object.assign(en, listsEn)` patches it in
 * for this test file only, exactly what `resolve()` in `registry.ts`
 * already falls back to for every other catalogue.
 *
 * The oracle, same shape as `MainToolbar.i18n.test.tsx`: mark every owned
 * key with a pseudo translation, render in English with a grouped + summed
 * result (so the grouping bar, column-header menu, and totals footer are
 * all on screen), capture the visible/focusable strings, switch locale
 * live, and assert every marked string that was readable in English
 * reappears marked. A second render exercises the schedule (pivot) table by
 * toggling the nested/schedule view button.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useState, act } from 'react';
import type { ListResult, ListGrouping } from '@ifc-lite/lists';
import { ProjectUnits } from '@ifc-lite/parser';
import { render, cleanup, click, press, type as typeInto } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { en } from '@/i18n/en';
import type { listsEn as ListsEnType } from '@/i18n/catalogues/lists.en';
import { useViewerStore } from '@/store';
import { ListResultsTable } from './ListResultsTable.js';

// Guarded dynamic import (#4918 revert-oracle) — see ListBuilder.i18n.test.tsx's
// identical comment for the full rationale.
let listsEn: typeof ListsEnType | undefined;
try {
  ({ listsEn } = await import('@/i18n/catalogues/lists.en'));
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') listsEn = undefined;
  else throw error;
}
const HAS_CATALOGUE = listsEn !== undefined;
const CATALOGUE: typeof ListsEnType = listsEn ?? ({} as typeof ListsEnType);
if (listsEn) Object.assign(en, listsEn);

type ListsKey = keyof typeof CATALOGUE;
const KEYS = Object.keys(CATALOGUE) as ListsKey[];
const OWNED_PREFIXES = ['lists.resultsTable.', 'lists.scheduleTable.', 'lists.groupingBar.', 'lists.columnMenu.'];
const OWNED_KEYS = KEYS.filter((k) => OWNED_PREFIXES.some((p) => k.startsWith(p)));
const STATIC_KEYS = OWNED_KEYS.filter((key) => {
  const v = CATALOGUE[key];
  return typeof v === 'string' && !v.includes('{');
});

const englishOf = (key: ListsKey): string => {
  const v = CATALOGUE[key];
  return typeof v === 'string' ? v : v.other;
};
const mark = (key: ListsKey) => `⟦${key}|${englishOf(key)}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(OWNED_KEYS.map((key) => [key, mark(key)])) as Catalogue;

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach((element) => {
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
}

/** aria-labels, `title` attrs, plain text, and every reachable Radix
 *  `TooltipContent` string (focus each button — Radix opens synchronously). */
function readableStrings(container: HTMLElement): Set<string> {
  const out = new Set<string>();
  addReadable(document.body, out);
  for (const button of container.querySelectorAll('button')) {
    act(() => button.focus());
    addReadable(document.body, out);
    act(() => button.blur());
  }
  return out;
}

function assertCoverage(english: Set<string>, after: Set<string>, keys: readonly ListsKey[]): Set<ListsKey> {
  const covered = new Set<ListsKey>();
  for (const key of keys) {
    const text = englishOf(key);
    if (!english.has(text)) continue;
    assert.ok(after.has(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
    covered.add(key);
  }
  return covered;
}

// ---------------------------------------------------------------------------
// A grouped + summed result: one text column (grouped) and one numeric
// column (summed) over two rows in two group buckets, so the grouping bar's
// chips, the column-header menu's sum/group state, and the totals footer
// all have something to show.
// ---------------------------------------------------------------------------

function buildResult(): ListResult {
  return {
    columns: [
      { id: 'col-name', source: 'attribute', propertyName: 'Name', label: 'Name' },
      { id: 'col-qty', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetVolume', label: 'Net Volume' },
    ],
    rows: [
      { entityId: 1, modelId: 'default', values: ['Wall A', 10] },
      { entityId: 2, modelId: 'default', values: ['Wall B', 20] },
    ],
    totalCount: 2,
    executionTime: 4,
  };
}

function buildGrouping(): ListGrouping {
  return { columnId: 'col-name', columnIds: ['col-name'], sumColumnIds: ['col-qty'], view: 'nested' };
}

const MODEL_UNITS = new Map([['default', ProjectUnits.empty()]]);

/** Local state wrapper so `onGroupingChange` (the nested/schedule toggle,
 *  and `ColumnHeaderMenu`'s own sort/group/sum/colour actions) actually
 *  re-renders the table, the same way `ListPanel` wires it in production. */
function Harness() {
  const [grouping, setGrouping] = useState<ListGrouping | undefined>(buildGrouping());
  return (
    <ListResultsTable
      result={buildResult()}
      listName="Wall List"
      grouping={grouping}
      onGroupingChange={setGrouping}
      modelUnits={MODEL_UNITS}
    />
  );
}

let initialState: ReturnType<typeof useViewerStore.getState>;

describe('ListResultsTable / ListGroupingBar / ColumnHeaderMenu localization (#4918)', { skip: !HAS_CATALOGUE && 'lists.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  beforeEach(() => {
    initialState = useViewerStore.getState();
    setLocale('en');
    // Row visibility filtering defaults on and needs a real basket/geometry
    // setup this test doesn't build — every assertion below toggles it off
    // first via the "Showing visible objects only" button (`Eye`/`EyeOff`)
    // so the two synthetic rows actually render.
  });
  afterEach(() => {
    cleanup();
    setLocale('en');
    useViewerStore.setState(initialState, true);
  });

  it('translates the toolbar, header, grouping bar, column menu, and totals footer (nested view)', () => {
    const container = render(<Harness />);

    // Reveal the two synthetic rows (see beforeEach note).
    const visibilityToggle = container.querySelector('button[aria-label="Showing visible objects only"]');
    assert.ok(visibilityToggle, 'expected the visibility-filter toggle button');
    click(visibilityToggle as Element);

    const english = readableStrings(container);

    registerLocale('list-results-nested-pseudo', PSEUDO);
    act(() => setLocale('list-results-nested-pseudo'));
    const after = readableStrings(container);

    // This is the NESTED view (no `ListScheduleTable` mounted); its own
    // `dragToResizeTitle`/`sumIcon`/`count`-shaped keys share exact English
    // text with `ListScheduleTable`'s (schedule-only, checked in the
    // "schedule (pivot) table" test below) — checking a schedule-only key
    // here would false-pass off the nested view's identical string, so this
    // pass covers everything EXCEPT `lists.scheduleTable.*`.
    const nestedViewKeys = STATIC_KEYS.filter((k) => !k.startsWith('lists.scheduleTable.'));
    const covered = assertCoverage(english, after, nestedViewKeys);

    assert.ok(covered.has('lists.resultsTable.showingAllObjects'), 'expected the toggled-off state\'s label/tooltip to be visible');
    assert.ok(covered.size > 0, 'expected at least one static key to be visible in the nested-view render');

    // Interpolated keys, checked against their actual interpolated text
    // rather than `covered` (STATIC_KEYS deliberately excludes any key
    // with a `{param}` — this render exercises them directly).
    assert.ok(english.has('Grouped by Name'), 'expected the "Grouped by Name" chip (groupedByChip, {label})');
    assert.ok(after.has(mark('lists.groupingBar.groupedByChip').replace('{label}', 'Name')), 'groupedByChip must be translated');

    assert.ok(english.has('2 groups · 2 elements'), 'expected the grouping-bar count summary (groupCount + elementCount, {countDisplay})');
    const markedGroupCount = mark('lists.groupingBar.groupCount').replace('{countDisplay}', '2');
    const markedElementCount = mark('lists.groupingBar.elementCount').replace('{countDisplay}', '2');
    assert.ok(after.has(`${markedGroupCount} · ${markedElementCount}`), 'groupCount/elementCount must be translated');

    assert.ok(english.has('Total · 2'), 'expected the grand-totals footer (totalCount, {count})');
    assert.ok(after.has(mark('lists.resultsTable.totalCount').replace('{count}', '2')), 'totalCount must be translated');
  });

  it('translates the interpolated row-count and totals text directly', () => {
    const container = render(<Harness />);
    const visibilityToggle = container.querySelector('button[aria-label="Showing visible objects only"]')!;
    click(visibilityToggle);

    const rowCountSpan = [...container.querySelectorAll('span')].find((s) => /\d+ rows?$/.test(s.textContent ?? ''));
    assert.ok(rowCountSpan, 'expected the row-count span');
    assert.equal(rowCountSpan!.textContent, '2 rows');

    registerLocale('list-results-rowcount-pseudo', PSEUDO);
    act(() => setLocale('list-results-rowcount-pseudo'));
    assert.equal(rowCountSpan!.textContent, mark('lists.resultsTable.rowCount').replace('{countDisplay}', '2'));

    act(() => setLocale('en'));
    typeInto(container.querySelector('input[placeholder="Filter results..."]') as HTMLInputElement, 'Wall A');
    assert.equal(rowCountSpan!.textContent, '1 / 2 row');
  });

  it('translates the schedule (pivot) table once toggled from nested view', () => {
    const container = render(<Harness />);
    const visibilityToggle = container.querySelector('button[aria-label="Showing visible objects only"]')!;
    click(visibilityToggle);

    const scheduleToggle = container.querySelector('button[aria-label="Switch to schedule (pivot) table view"]');
    assert.ok(scheduleToggle, 'expected the nested/schedule view toggle (only shown once grouped)');
    click(scheduleToggle as Element);

    const english = readableStrings(container);
    registerLocale('list-schedule-pseudo', PSEUDO);
    act(() => setLocale('list-schedule-pseudo'));
    const after = readableStrings(container);

    const scheduleKeys = STATIC_KEYS.filter((k) => k.startsWith('lists.scheduleTable.') || k.startsWith('lists.groupingBar.'));
    const covered = assertCoverage(english, after, scheduleKeys);
    assert.ok(covered.has('lists.scheduleTable.count'), 'expected the pivot table\'s Count column header');
    assert.ok(covered.has('lists.groupingBar.switchToNestedAriaLabel'), 'expected the toggle button to now offer switching back to nested');

    // `totalGroups` is a plural key ({count} selects the category,
    // {countDisplay} is what's actually shown — #4918 review, PR #5004),
    // excluded from STATIC_KEYS — checked directly against its interpolated
    // text (2 leaf groups here).
    assert.ok(english.has('Total · 2 groups'), 'expected the pivot table\'s grand-totals footer');
    assert.ok(after.has(mark('lists.scheduleTable.totalGroups').replace('{countDisplay}', '2')), 'totalGroups must be translated');
  });

  it('translates the column-header menu (sort / group / sum / colour actions)', () => {
    const container = render(<Harness />);
    const visibilityToggle = container.querySelector('button[aria-label="Showing visible objects only"]')!;
    click(visibilityToggle);

    const menuTrigger = container.querySelector('button[aria-label="Column options"]');
    assert.ok(menuTrigger, 'expected at least one column-options trigger');
    click(menuTrigger as Element);

    const english = readableStrings(container);
    registerLocale('list-column-menu-pseudo', PSEUDO);
    act(() => setLocale('list-column-menu-pseudo'));
    const after = readableStrings(container);

    const columnMenuKeys = STATIC_KEYS.filter((k) => k.startsWith('lists.columnMenu.'));
    const covered = assertCoverage(english, after, columnMenuKeys);
    assert.ok(covered.size > 0, 'expected at least one ColumnHeaderMenu item to be visible with the menu open');
  });

  it('#5814 keeps column sorting and options available when the result has no rows', () => {
    const emptyResult = { ...buildResult(), rows: [], totalCount: 0 };
    const container = render(
      <ListResultsTable result={emptyResult} modelUnits={MODEL_UNITS} onGroupingChange={() => {}} />,
    );
    assert.ok(container.textContent?.includes('No matching rows'));
    const nameHeader = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Name');
    assert.ok(nameHeader, 'the Name column remains sortable');
    const menuTrigger = container.querySelector('button[aria-label="Column options"]');
    assert.ok(menuTrigger, 'column options remain available with zero rows');
    press(menuTrigger, 'Enter');
    assert.ok(document.body.textContent?.includes('Sort ascending'), 'the options menu still opens');
  });

  it('#5814 keeps pivot headers available when a schedule has no visible rows', () => {
    const container = render(<Harness />);
    const scheduleToggle = container.querySelector('button[aria-label="Switch to schedule (pivot) table view"]');
    assert.ok(scheduleToggle);
    click(scheduleToggle);
    const headerButtons = [...container.querySelectorAll('button')].map((button) => button.textContent?.trim());
    assert.ok(headerButtons.includes('Name'), 'the grouping column stays sortable');
    assert.ok(headerButtons.some((label) => label?.startsWith('Net Volume')), 'the sum column stays sortable');
    assert.ok(container.textContent?.includes('Count'), 'the pivot count header stays visible');
    assert.ok(container.textContent?.includes('No matching rows'), 'the empty message remains visible');
  });
});
