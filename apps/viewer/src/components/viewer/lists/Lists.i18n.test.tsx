/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ListPanel` / `ListLibrary` / `ListModelTagScopeEditor` / `ListErrorBox`
 * localization (#4918 lists slice), covering the `lists.panel.*`,
 * `lists.library.*`, `lists.modelTagScope.*` and `lists.errorBox.*` keys of
 * `apps/viewer/src/i18n/catalogues/lists.en.ts`. `ListBuilder`'s own
 * `lists.builder.*` keys and `ListResultsTable`/`ListScheduleTable`/
 * `ListGroupingBar`/`ColumnHeaderMenu`'s `lists.resultsTable.*` /
 * `lists.scheduleTable.*` / `lists.groupingBar.*` / `lists.columnMenu.*` keys
 * are covered by the sibling `ListBuilder.i18n.test.tsx` and
 * `ListResultsTable.i18n.test.tsx` files instead.
 *
 * The catalogue is not wired into `apps/viewer/src/i18n/en.ts` yet (that
 * merge is the integration pass for the whole #4918 sweep) — `en` is a
 * plain, non-frozen object, so `Object.assign(en, listsEn)` below patches
 * it in for this test file only, exactly the way `resolve()` in
 * `registry.ts` already falls back to `en[key]` for every other catalogue.
 *
 * The oracle: mark every `lists.*` key covered here with a pseudo
 * translation, render in English, capture the visible/focusable strings,
 * switch locale live, and assert every marked string that was readable in
 * English reappears marked. A label left hardcoded, or a consumer that does
 * not re-render on a locale switch, fails here by name.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { StringTable, EntityTableBuilder } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { render, cleanup, click, advance } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { en } from '@/i18n/en';
import type { listsEn as ListsEnType } from '@/i18n/catalogues/lists.en';
import { useViewerStore } from '@/store';
import type { ListDefinition } from '@/lib/lists';
import { ListPanel } from './ListPanel.js';
import { ListModelTagScopeEditor } from './ListModelTagScopeEditor.js';
import { ListErrorBox } from './ListErrorBox.js';

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
/** Only this file's own prefixes — the sibling test files own the rest. */
const OWNED_PREFIXES = ['lists.panel.', 'lists.library.', 'lists.modelTagScope.', 'lists.errorBox.'];
const OWNED_KEYS = KEYS.filter((k) => OWNED_PREFIXES.some((p) => k.startsWith(p)));

const englishOf = (key: ListsKey): string => {
  const v = CATALOGUE[key];
  return typeof v === 'string' ? v : v.other;
};

const mark = (key: ListsKey) => `⟦${key}|${englishOf(key)}⟧`;
const PSEUDO: Catalogue = {
  ...Object.fromEntries(OWNED_KEYS.map((key) => [key, mark(key)])),
  'filterOperators.hasAny': '⟦filterOperators.hasAny|has any of⟧',
  'filterOperators.hasAll': '⟦filterOperators.hasAll|has all of⟧',
  'filterOperators.hasNone': '⟦filterOperators.hasNone|has none of⟧',
  'filterOperators.untagged': '⟦filterOperators.untagged|is untagged⟧',
} as Catalogue;

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

/** aria-labels, `title` attributes, plain text, and every reachable Radix
 *  `TooltipContent` string (focus each button in turn — Radix opens a
 *  tooltip synchronously on focus). */
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
    if (!english.has(text)) continue; // not on screen in this render; checked elsewhere
    assert.ok(after.has(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
    covered.add(key);
  }
  return covered;
}

// ---------------------------------------------------------------------------
// ListPanel + ListLibrary: real store-backed render (same shape as
// `ListPanel.wiring.test.tsx`), one real IfcWall so `hasData` is true and
// the run/execute path actually completes.
// ---------------------------------------------------------------------------

const MODEL_ID = 'model-a';

function buildStore(): IfcDataStore {
  const strings = new StringTable();
  const builder = new EntityTableBuilder(1, strings);
  builder.add(42, 'IFCWALL', '1abcdefghijklmnopqrstu', 'Wall A', '', '', true, false);
  return {
    fileSize: 0,
    schemaVersion: 'IFC4',
    entityCount: 1,
    parseTime: 0,
    source: new Uint8Array(0),
    entityIndex: { byId: { ranges: new Uint32Array(0), index: new Map() }, byType: new Map([['IFCWALL', [42]]]) },
    strings,
    entities: builder.build(),
    properties: undefined,
    quantities: undefined,
    relationships: { count: 0, getRelated: () => [] },
    spatialHierarchy: undefined,
  } as unknown as IfcDataStore;
}

function savedList(): ListDefinition {
  return {
    id: 'list-1',
    name: 'My Saved List',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    entityTypes: [],
    conditions: [],
    columns: [{ id: 'col-1', source: 'attribute', propertyName: 'Name', label: 'Name' }],
  } as unknown as ListDefinition;
}

function seedPanelStore(definitions: ListDefinition[]): void {
  useViewerStore.setState({
    models: new Map([[MODEL_ID, {
      id: MODEL_ID,
      name: MODEL_ID,
      visible: true,
      idOffset: 0,
      ifcDataStore: buildStore(),
    } as never]]),
    activeModelId: MODEL_ID,
    listDefinitions: definitions,
    activeListId: null,
    listResult: null,
    listExecuting: false,
    listError: null,
    listPanelVisible: true,
    pendingListDraft: null,
    zoneSets: [],
    zoneAssignments: {} as never,
    zoneApportionment: undefined,
  } as never);
}

let initialPanelState: ReturnType<typeof useViewerStore.getState>;

describe('ListPanel + ListLibrary localization (#4918)', { skip: !HAS_CATALOGUE && 'lists.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  beforeEach(() => {
    initialPanelState = useViewerStore.getState();
    setLocale('en');
  });
  afterEach(() => {
    cleanup();
    setLocale('en');
    useViewerStore.setState(initialPanelState, true);
  });

  it('translates the library view: header, actions, and per-row controls', () => {
    const list = savedList();
    seedPanelStore([list]);
    const container = render(<ListPanel />);
    const english = readableStrings(container);

    registerLocale('lists-panel-library-pseudo', PSEUDO);
    act(() => setLocale('lists-panel-library-pseudo'));
    const after = readableStrings(container);

    const libraryKeys: ListsKey[] = [
      'lists.panel.title',
      'lists.library.newList',
      'lists.library.import',
      'lists.library.savedLists',
      'lists.library.templates',
      'lists.library.run',
      'lists.library.edit',
      'lists.library.duplicate',
      'lists.library.useAsTemplate',
      'lists.library.export',
      'lists.library.delete',
    ];
    for (const key of libraryKeys) {
      const text = englishOf(key);
      assert.ok(english.has(text), `${key}: expected "${text}" to be visible in the library render`);
      assert.ok(after.has(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
    }

    // {name}-interpolated aria-labels: check against the interpolated
    // English/marked text (the saved-list row) rather than the raw template.
    const interpolated: [ListsKey, string][] = [
      ['lists.library.runListAriaLabel', list.name],
      ['lists.library.editListAriaLabel', list.name],
      ['lists.library.duplicateListAriaLabel', list.name],
      ['lists.library.exportListAriaLabel', list.name],
      ['lists.library.deleteListAriaLabel', list.name],
    ];
    for (const [key, name] of interpolated) {
      const englishText = (englishOf(key) as string).replace('{name}', name);
      const markedText = mark(key).replace('{name}', name);
      assert.ok(english.has(englishText), `${key}: expected "${englishText}" to be visible`);
      assert.ok(after.has(markedText), `${key}: "${englishText}" must be translated, marked text not found`);
    }
  });

  it('translates the "Use as Template" aria-label on a preset row', () => {
    seedPanelStore([]);
    const container = render(<ListPanel />);

    // Captured while still English: a preset row's aria-label reads
    // "Use <preset name> as template" (`useAsTemplateAriaLabel`).
    const presetButton = [...container.querySelectorAll('button[aria-label]')]
      .find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Use '));
    assert.ok(presetButton, 'expected at least one LIST_PRESETS row offering "Use … as template"');
    const presetAria = presetButton!.getAttribute('aria-label') ?? '';
    const presetName = presetAria.replace(/^Use /, '').replace(/ as template$/, '');

    registerLocale('lists-preset-template-pseudo', PSEUDO);
    act(() => setLocale('lists-preset-template-pseudo'));
    const markedPresetAria = mark('lists.library.useAsTemplateAriaLabel').replace('{name}', presetName);
    assert.equal(presetButton!.getAttribute('aria-label'), markedPresetAria, 'useAsTemplateAriaLabel must be translated for a preset row');
  });

  it('translates the results view: header summary and the results-only actions', async () => {
    const list = savedList();
    seedPanelStore([list]);
    const container = render(<ListPanel />);

    const runButton = container.querySelector(`button[aria-label="Run list ${list.name}"]`);
    assert.ok(runButton, 'expected a Run button for the saved list');
    click(runButton as Element);
    await advance(60);

    const english = readableStrings(container);
    registerLocale('lists-panel-results-pseudo', PSEUDO);
    act(() => setLocale('lists-panel-results-pseudo'));
    const after = readableStrings(container);

    const result = useViewerStore.getState().listResult;
    assert.ok(result);
    const summaryValue = CATALOGUE['lists.panel.resultsSummary'];
    const englishSummary = typeof summaryValue === 'string'
      ? summaryValue
      : result.totalCount === 1 ? summaryValue.one : summaryValue.other;
    const renderSummary = (template: string) => `(${template
      .replace('{countDisplay}', String(result.totalCount))
      .replace('{ms}', result.executionTime.toFixed(0))})`;
    assert.ok(english.has(renderSummary(englishSummary)));
    assert.ok(after.has(renderSummary(mark('lists.panel.resultsSummary'))));

    const resultsKeys: ListsKey[] = [
      'lists.panel.editList',
      'lists.panel.results',
      'lists.panel.editConfiguration',
      'lists.panel.backToLists',
    ];
    const covered = assertCoverage(english, after, resultsKeys);
    assert.ok(covered.has('lists.panel.results'), 'expected the results view to actually be showing');
  });

  it('translates the builder view chrome (New List / Cancel)', () => {
    seedPanelStore([]);
    const container = render(<ListPanel />);

    const newListButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('New List'));
    assert.ok(newListButton, 'expected a New List button');
    click(newListButton as Element);

    const english = readableStrings(container);
    registerLocale('lists-panel-builder-pseudo', PSEUDO);
    act(() => setLocale('lists-panel-builder-pseudo'));
    const after = readableStrings(container);

    assertCoverage(english, after, ['lists.panel.newList', 'lists.panel.cancel']);
  });
});

// ---------------------------------------------------------------------------
// ListModelTagScopeEditor
// ---------------------------------------------------------------------------

let structureTagId = '';
let mepTagId = '';

function seedModelTagStore(): void {
  useViewerStore.setState({ models: new Map(), modelTags: new Map(), modelTagAssignments: new Map() });
  const s = useViewerStore.getState();
  structureTagId = s.createModelTag('Structure')!;
  mepTagId = s.createModelTag('MEP')!;
}

describe('ListModelTagScopeEditor localization (#4918)', { skip: !HAS_CATALOGUE && 'lists.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  let initialTagState: ReturnType<typeof useViewerStore.getState>;
  beforeEach(() => {
    initialTagState = useViewerStore.getState();
    setLocale('en');
    seedModelTagStore();
  });
  afterEach(() => {
    cleanup();
    setLocale('en');
    useViewerStore.setState(initialTagState, true);
  });

  it('translates the label, select, and "pick at least one tag" hint', () => {
    const container = render(
      <ListModelTagScopeEditor value={{ op: 'hasAny', tagIds: [] }} onChange={() => {}} />,
    );
    const english = readableStrings(container);

    registerLocale('lists-model-tag-scope-pseudo', PSEUDO);
    act(() => setLocale('lists-model-tag-scope-pseudo'));
    const after = readableStrings(container);

    assertCoverage(english, after, [
      'lists.modelTagScope.models',
      'lists.modelTagScope.selectAriaLabel',
      'lists.modelTagScope.allModels',
      'lists.modelTagScope.pickAtLeastOneTag',
    ]);
    for (const key of ['hasAny', 'hasAll', 'hasNone', 'untagged']) {
      assert.ok(after.has(`⟦filterOperators.${key}|${({
        hasAny: 'has any of', hasAll: 'has all of', hasNone: 'has none of', untagged: 'is untagged',
      } as Record<string, string>)[key]}⟧`), `shared operator ${key} must translate`);
    }
  });

  it('translates the "runs over" summary hint', () => {
    const container = render(
      <ListModelTagScopeEditor value={{ op: 'hasAll', tagIds: [structureTagId, mepTagId] }} onChange={() => {}} />,
    );
    const hint = container.querySelector('[data-list-model-tag-scope-hint]')?.textContent ?? '';
    assert.match(hint, /^Runs over /, 'expected the English "Runs over …" hint');

    registerLocale('lists-model-tag-scope-hint-pseudo', PSEUDO);
    act(() => setLocale('lists-model-tag-scope-hint-pseudo'));
    const after = container.querySelector('[data-list-model-tag-scope-hint]')?.textContent ?? '';
    // One complete message per operator (#4918 review, PR #5004) rather than
    // a generic "Runs over {description}." wrapper — this render's `op` is
    // 'hasAll', so the key is `runsOverHasAll`.
    assert.match(after, /⟦lists\.modelTagScope\.runsOverHasAll\|/, 'the interpolated hint must go through t()');
  });

  it('translates the unresolved-tag plural warning (singular and plural forms)', () => {
    const one = render(
      <ListModelTagScopeEditor value={{ op: 'hasAny', tagIds: ['deleted-tag-1'] }} onChange={() => {}} />,
    );
    const oneText = one.querySelector('[role="alert"]')?.textContent ?? '';
    assert.match(oneText, /no longer exists/);
    registerLocale('lists-unresolved-one-pseudo', PSEUDO);
    act(() => setLocale('lists-unresolved-one-pseudo'));
    const oneAfter = one.querySelector('[role="alert"]')?.textContent ?? '';
    assert.match(oneAfter, /⟦lists\.modelTagScope\.unresolvedTagsWarning\|/);
    cleanup();
    setLocale('en');

    const many = render(
      <ListModelTagScopeEditor value={{ op: 'hasAny', tagIds: ['deleted-tag-1', 'deleted-tag-2'] }} onChange={() => {}} />,
    );
    const manyText = many.querySelector('[role="alert"]')?.textContent ?? '';
    assert.match(manyText, /no longer exist\b/);
    act(() => setLocale('lists-unresolved-one-pseudo'));
    const manyAfter = many.querySelector('[role="alert"]')?.textContent ?? '';
    assert.match(manyAfter, /⟦lists\.modelTagScope\.unresolvedTagsWarning\|/);
  });
});

// ---------------------------------------------------------------------------
// ListErrorBox
// ---------------------------------------------------------------------------

describe('ListErrorBox localization (#4918)', { skip: !HAS_CATALOGUE && 'lists.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  afterEach(() => {
    cleanup();
    setLocale('en');
  });

  it('translates the "List failed" heading and the dismiss aria-label', () => {
    const container = render(<ListErrorBox message="Something went wrong" onDismiss={() => {}} />);
    const english = readableStrings(container);

    registerLocale('lists-error-box-pseudo', PSEUDO);
    act(() => setLocale('lists-error-box-pseudo'));
    const after = readableStrings(container);

    assertCoverage(english, after, ['lists.errorBox.listFailed', 'lists.errorBox.dismissAriaLabel']);
  });
});
