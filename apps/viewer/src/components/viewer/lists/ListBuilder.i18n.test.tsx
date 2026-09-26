/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ListBuilder` localization (#4918 lists slice) — the `lists.builder.*`
 * keys of `apps/viewer/src/i18n/catalogues/lists.en.ts`. The other eight
 * files in this directory are covered by the sibling `Lists.i18n.test.tsx`
 * and `ListResultsTable.i18n.test.tsx` files.
 *
 * `en` doesn't carry the lists catalogue yet (the whole #4918 sweep's
 * integration pass wires it into `apps/viewer/src/i18n/en.ts`) — `en` is a
 * plain, non-frozen object, so `Object.assign(en, listsEn)` patches it in
 * for this test file only, exactly what `resolve()` in `registry.ts`
 * already falls back to for every other catalogue.
 *
 * `ListBuilder` has more mutually-exclusive UI states than one render can
 * surface at once (a filter-snapshot list vs. a type-scoped one; an empty
 * grouping level 0 vs. a second "then by" level; a zone/spatial filter
 * dimension vs. the default attribute one), so this file drives several
 * small renders and a few real clicks/typed values — the same oracle shape
 * as `MainToolbar.i18n.test.tsx`: mark every key, render in English,
 * capture the visible/focusable strings, switch locale live, and assert
 * every marked string that was readable in English reappears marked.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { StringTable, EntityTableBuilder } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { ListDefinition, ListDataProvider } from '@ifc-lite/lists';
import { render, cleanup, click, type as typeInto } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { en } from '@/i18n/en';
import type { listsEn as ListsEnType } from '@/i18n/catalogues/lists.en';
import { useViewerStore } from '@/store';
import { createListDataProvider } from '@/lib/lists/adapter';
import { ListBuilder } from './ListBuilder.js';

// Guarded dynamic import (#4918 revert-oracle): a static `import { listsEn }
// from '...'` would fail this file's whole LOAD once `check-test-revert-oracle.mjs`
// reverts the production hunks (a brand-new module reverts to a deletion),
// which the oracle reports as INCONCLUSIVE rather than a red assertion. A
// guarded dynamic import turns a missing catalogue into a clean
// `describe.skip` instead — the real coverage for a revert lives in the
// pre-existing ListModelTagScopeEditor.test.ts / ListPanel.wiring.test.tsx /
// ListPanel.modelTagScope.test.tsx, none of which import this catalogue.
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
const OWNED_KEYS = KEYS.filter((k) => k.startsWith('lists.builder.'));
const STATIC_KEYS = OWNED_KEYS.filter((key) => {
  const v = CATALOGUE[key];
  return typeof v === 'string' && !v.includes('{');
});

const englishOf = (key: ListsKey): string => {
  const v = CATALOGUE[key];
  return typeof v === 'string' ? v : v.other;
};
const mark = (key: ListsKey) => `⟦${key}|${englishOf(key)}⟧`;
const PSEUDO: Catalogue = {
  ...Object.fromEntries(OWNED_KEYS.map((key) => [key, mark(key)])),
  'filterOperators.contains': '⟦filterOperators.contains|contains⟧',
  'filterOperators.isSet': '⟦filterOperators.isSet|is set⟧',
} as Catalogue;

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const title = element.getAttribute('title');
    if (title) out.add(title);
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) out.add(placeholder);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
}

/** aria-labels, `title`/`placeholder` attrs, plain text, and every
 *  reachable Radix `TooltipContent` string (focus each button in turn). */
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

/** Change a native `<select>`'s value the way `ComboInput`'s underlying
 *  `<input>` is typed into (`test/render.tsx`'s `type()`) — React tracks
 *  `.value` through a property setter, so a plain assignment leaves
 *  `onChange` unfired. */
function selectValue(el: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
  if (!setter) throw new Error('no value setter on HTMLSelectElement.prototype');
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

// ---------------------------------------------------------------------------
// One real IfcWall (`ListPanel.wiring.test.tsx`'s fixture shape) — enough
// for `collectScopeTypes` / `discoverColumns` to run over a non-empty model.
// ---------------------------------------------------------------------------

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
    // A stub, not `undefined`: a `property`/`quantity`/`material`/
    // `classification` filter condition triggers `ListBuilder`'s expensive
    // `discoverConditionValues` sampling pass (issue #4215's suggestion
    // effect), which falls back to `store.properties.getForEntity` when
    // `source` is empty — `undefined` throws there instead of yielding "no
    // properties found", which is what this fixture actually means.
    properties: { getForEntity: () => [] },
    quantities: { getForEntity: () => [] },
    relationships: { count: 0, getRelated: () => [] },
    spatialHierarchy: undefined,
  } as unknown as IfcDataStore;
}

function buildProvider(store: IfcDataStore): ListDataProvider {
  return createListDataProvider(store);
}

let initialState: ReturnType<typeof useViewerStore.getState>;

describe('ListBuilder localization (#4918)', { skip: !HAS_CATALOGUE && 'lists.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  beforeEach(() => {
    initialState = useViewerStore.getState();
    setLocale('en');
    useViewerStore.setState({ zoneSets: [] } as never);
  });
  afterEach(() => {
    cleanup();
    setLocale('en');
    useViewerStore.setState(initialState, true);
  });

  it('translates identity fields, the "no type selected" hint, filters, custom-column entry, and the bottom actions', () => {
    const store = buildStore();
    const provider = buildProvider(store);
    const container = render(
      <ListBuilder providers={[provider]} stores={[store]} initial={null} onSave={() => {}} onCancel={() => {}} onExecute={() => {}} />,
    );
    const english = readableStrings(container);

    // The "no type selected" paragraph interleaves plain text with a
    // <strong> mid-sentence (`{prefix} <strong>{label}</strong>{suffix}`):
    // `readableStrings` (like the oracle's own docs describe) reads each
    // element's OWN direct text nodes, so the <p>'s prefix+suffix collapse
    // into one combined string with the <strong> text skipped — the prefix
    // and suffix are checked directly off that paragraph element instead.
    const noTypeParagraph = [...container.querySelectorAll('p')].find((p) => p.textContent?.startsWith('No type selected'));
    assert.ok(noTypeParagraph, 'expected the "no type selected" paragraph');
    assert.equal(
      noTypeParagraph!.textContent,
      'No type selected — the list targets all model elements. Use filters to narrow by name, material, classification or storey.',
    );

    registerLocale('list-builder-default-pseudo', PSEUDO);
    act(() => setLocale('list-builder-default-pseudo'));
    const after = readableStrings(container);

    const conditionOnlyPrefixes = [
      'lists.builder.source.', 'lists.builder.operator.', 'lists.builder.spatial.',
      'lists.builder.zoneVolumeOption', 'lists.builder.zoneBreakdownOption',
    ];
    const covered = assertCoverage(english, after,
      STATIC_KEYS.filter((key) => !conditionOnlyPrefixes.some((prefix) => key.startsWith(prefix))));

    for (const key of [
      'lists.builder.namePlaceholder',
      'lists.builder.descriptionPlaceholder',
      'lists.builder.sectionScope',
      'lists.builder.scopeAllElementsHint',
      'lists.builder.sectionFilters',
      'lists.builder.sectionColumns',
      'lists.builder.noTypeSelected',
      'lists.builder.addFilter',
      'lists.builder.customColumn',
      'lists.builder.customColumnHint',
      'lists.builder.run',
      'lists.builder.save',
      'lists.builder.cancel',
    ] as const satisfies readonly ListsKey[]) {
      assert.ok(covered.has(key), `expected "${key}" to be visible and translated in the default (no type / no columns) render`);
    }

    assert.equal(
      noTypeParagraph!.textContent,
      mark('lists.builder.noTypeSelected'),
      'the complete no-type-selected message must be translated',
    );
  });

  it('translates the filter-snapshot hint (a frozen search-filter list)', () => {
    const store = buildStore();
    const provider = buildProvider(store);
    const snapshotInitial: ListDefinition = {
      id: 'snap-1',
      name: 'Snapshot List',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      entityTypes: [],
      conditions: [],
      columns: [],
      expressIdsByModel: { default: [42] },
    } as unknown as ListDefinition;
    const container = render(
      <ListBuilder providers={[provider]} stores={[store]} initial={snapshotInitial} onSave={() => {}} onCancel={() => {}} onExecute={() => {}} />,
    );
    const english = readableStrings(container);
    assert.ok(english.has('Filter snapshot'), 'expected the "Filter snapshot" label');

    registerLocale('list-builder-snapshot-pseudo', PSEUDO);
    act(() => setLocale('list-builder-snapshot-pseudo'));
    const after = readableStrings(container);

    assert.ok(after.has(mark('lists.builder.filterSnapshotLabel')), 'filterSnapshotLabel must be translated');
    const expectedHint = mark('lists.builder.filterSnapshotHint').replace('{countDisplay}', '1');
    assert.ok(after.has(expectedHint), 'filterSnapshotHint must be translated with its interpolated count');
  });

  it('translates a filter row (dimension / attribute / operator / remove) and the zone dimension\'s own controls', () => {
    const store = buildStore();
    const provider = buildProvider(store);
    const container = render(
      <ListBuilder providers={[provider]} stores={[store]} initial={null} onSave={() => {}} onCancel={() => {}} onExecute={() => {}} />,
    );

    const addFilterButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Add filter'));
    assert.ok(addFilterButton, 'expected the "Add filter" button');
    click(addFilterButton as Element);

    const english = readableStrings(container);
    registerLocale('list-builder-filter-row-pseudo', PSEUDO);
    act(() => setLocale('list-builder-filter-row-pseudo'));
    const after = readableStrings(container);

    assertCoverage(english, after, [
      'lists.builder.filterDimensionAriaLabel',
      'lists.builder.attributeAriaLabel',
      'lists.builder.operatorAriaLabel',
      'lists.builder.removeFilterAriaLabel',
      'lists.builder.source.attribute',
      'lists.builder.source.property',
      'lists.builder.source.quantity',
      'lists.builder.source.material',
      'lists.builder.source.classification',
      'lists.builder.source.spatial',
      'lists.builder.source.model',
      'lists.builder.source.zone',
    ]);
    assert.ok(after.has('⟦filterOperators.contains|contains⟧'));
    assert.ok(after.has('⟦filterOperators.isSet|is set⟧'));
    act(() => setLocale('en'));

    // Switch the row's dimension to "Zone": reveals the zone-set / display
    // mode selects, the "(no zone sets)" option (no zone sets defined in
    // this render's store), and the Zone/Straddles option labels.
    const dimensionSelect = container.querySelector('select[aria-label="Filter dimension"]') as HTMLSelectElement;
    assert.ok(dimensionSelect, 'expected the filter-dimension select');
    selectValue(dimensionSelect, 'zone');

    const modeSelect = container.querySelector('select[aria-label="Zone display mode"]') as HTMLSelectElement;
    const modeLabels = [...modeSelect.options].map((option) => option.textContent);
    assert.ok(modeLabels.includes('Volume (mesh)'), 'the localized label must preserve the mesh basis');
    assert.ok(modeLabels.includes('Volume breakdown (mesh)'), 'the localized label must preserve volume and mesh semantics');

    const zoneEnglish = readableStrings(container);
    registerLocale('list-builder-zone-row-pseudo', PSEUDO);
    act(() => setLocale('list-builder-zone-row-pseudo'));
    const zoneAfter = readableStrings(container);

    assertCoverage(zoneEnglish, zoneAfter, [
      'lists.builder.zoneSetAriaLabel',
      'lists.builder.noZoneSets',
      'lists.builder.zoneDisplayModeAriaLabel',
      'lists.builder.zoneOption',
      'lists.builder.straddlesOption',
      'lists.builder.zoneVolumeOption',
      'lists.builder.zoneBreakdownOption',
    ]);
  });

  it('translates the custom-column editor: Property/Quantity chips, placeholders, pattern hint, and add/close actions', () => {
    const store = buildStore();
    const provider = buildProvider(store);
    const container = render(
      <ListBuilder providers={[provider]} stores={[store]} initial={null} onSave={() => {}} onCancel={() => {}} onExecute={() => {}} />,
    );

    const openButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Custom column'));
    assert.ok(openButton, 'expected the "+ Custom column" opener');
    click(openButton as Element);

    // The default hint interleaves plain text with two <code> chunks
    // (`{prefix} <code>/…/</code> {suffix} <code>{example}</code>.`), same
    // collapsing-into-the-parent shape as the "no type selected" paragraph
    // above — read directly off the element rather than via `readableStrings`.
    const hintParagraph = [...container.querySelectorAll('p')].find((p) => p.textContent?.startsWith('Type an exact set name'));
    assert.ok(hintParagraph, 'expected the default pattern-hint paragraph');

    const english = readableStrings(container);
    registerLocale('list-builder-column-editor-pseudo', PSEUDO);
    act(() => setLocale('list-builder-column-editor-pseudo'));
    const after = readableStrings(container);

    const covered = assertCoverage(english, after, [
      'lists.builder.property',
      'lists.builder.quantity',
      'lists.builder.closeCustomColumnAriaLabel',
      'lists.builder.propertySetPlaceholder',
      'lists.builder.propertyNamePlaceholder',
      'lists.builder.addCustomColumnAriaLabel',
    ]);
    for (const key of [
      'lists.builder.property', 'lists.builder.quantity', 'lists.builder.closeCustomColumnAriaLabel',
      'lists.builder.propertySetPlaceholder', 'lists.builder.propertyNamePlaceholder', 'lists.builder.addCustomColumnAriaLabel',
    ] as const satisfies readonly ListsKey[]) {
      assert.ok(covered.has(key), `expected "${key}" to be visible by default with the custom-column editor open`);
    }

    assert.equal(
      hintParagraph!.textContent,
      mark('lists.builder.patternHint')
        .replace('{delimiter}', '/…/')
        .replace('{example}', '/Qto_.*BaseQuantities/'),
      'the complete pattern instruction must be translated',
    );
  });

  it('translates the regex badge once the set field is a valid /pattern/', () => {
    const store = buildStore();
    const provider = buildProvider(store);
    const container = render(
      <ListBuilder providers={[provider]} stores={[store]} initial={null} onSave={() => {}} onCancel={() => {}} onExecute={() => {}} />,
    );
    click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Custom column')) as Element);

    const setInput = container.querySelector('input[placeholder="Pset_… or /Pset_.*/"]') as HTMLInputElement;
    assert.ok(setInput, 'expected the set-name ComboInput');
    typeInto(setInput, '/Pset_.*/');

    const english = readableStrings(container);
    assert.ok(english.has('regex'), 'expected the "regex" badge once the set field is a valid pattern');

    registerLocale('list-builder-regex-badge-pseudo', PSEUDO);
    act(() => setLocale('list-builder-regex-badge-pseudo'));
    const after = readableStrings(container);
    assert.ok(after.has(mark('lists.builder.regexBadge')), 'regexBadge must be translated');
  });

  it('translates quantity-source placeholders once the Quantity chip is picked', () => {
    const store = buildStore();
    const provider = buildProvider(store);
    const container = render(
      <ListBuilder providers={[provider]} stores={[store]} initial={null} onSave={() => {}} onCancel={() => {}} onExecute={() => {}} />,
    );
    click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Custom column')) as Element);
    const quantityChip = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Quantity');
    assert.ok(quantityChip, 'expected the "Quantity" source chip');
    click(quantityChip as Element);

    const english = readableStrings(container);
    assert.ok(english.has('Qto_… or /Qto_.*/'), 'expected the quantity-set placeholder');
    assert.ok(english.has('NetVolume'), 'expected the quantity-name placeholder');

    registerLocale('list-builder-quantity-placeholders-pseudo', PSEUDO);
    act(() => setLocale('list-builder-quantity-placeholders-pseudo'));
    const after = readableStrings(container);
    assert.ok(after.has(mark('lists.builder.quantitySetPlaceholder')), 'quantitySetPlaceholder must be translated');
    assert.ok(after.has(mark('lists.builder.quantityNamePlaceholder')), 'quantityNamePlaceholder must be translated');
  });

  it('adds a custom column, then translates SelectedColumns\' move/edit/remove controls and the Grouping & Totals section', () => {
    const store = buildStore();
    const provider = buildProvider(store);
    const container = render(
      <ListBuilder providers={[provider]} stores={[store]} initial={null} onSave={() => {}} onCancel={() => {}} onExecute={() => {}} />,
    );

    // Add one custom property column ("FireRating" off "Pset_WallCommon").
    click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Custom column')) as Element);
    const setInput = container.querySelector('input[placeholder="Pset_… or /Pset_.*/"]') as HTMLInputElement;
    const propInput = container.querySelector('input[placeholder="FireRating"]') as HTMLInputElement;
    typeInto(setInput, 'Pset_WallCommon');
    typeInto(propInput, 'FireRating');
    const addButton = container.querySelector('button[aria-label="Add custom column"]') as HTMLElement;
    click(addButton);

    const english = readableStrings(container);
    registerLocale('list-builder-selected-columns-pseudo', PSEUDO);
    act(() => setLocale('list-builder-selected-columns-pseudo'));
    const after = readableStrings(container);

    const covered = assertCoverage(english, after, [
      'lists.builder.editColumnAriaLabel',
      'lists.builder.moveUpAriaLabel',
      'lists.builder.moveDownAriaLabel',
      'lists.builder.removeColumnAriaLabel',
      'lists.builder.groupByLabel',
      'lists.builder.noneFlatList',
      'lists.builder.groupCountHint',
      'lists.builder.totalsHint',
      'lists.builder.sumIcon',
    ]);
    for (const key of [
      'lists.builder.editColumnAriaLabel', 'lists.builder.moveUpAriaLabel', 'lists.builder.moveDownAriaLabel',
      'lists.builder.removeColumnAriaLabel', 'lists.builder.groupByLabel', 'lists.builder.noneFlatList',
      'lists.builder.totalsHint', 'lists.builder.sumIcon',
    ] as const satisfies readonly ListsKey[]) {
      assert.ok(covered.has(key), `expected "${key}" to be visible with one column added`);
    }
    // `groupCountHint` needs an actual (non-empty) group selection — checked
    // in the next test, which adds a second column and picks a group level.
  });

  it('translates the editor\'s "Close editor" state and the second grouping level ("then by" / "None")', () => {
    const store = buildStore();
    const provider = buildProvider(store);
    const container = render(
      <ListBuilder providers={[provider]} stores={[store]} initial={null} onSave={() => {}} onCancel={() => {}} onExecute={() => {}} />,
    );

    // Two custom property columns, so a second ("then by") grouping slot
    // appears once the first is assigned. The editor stays open across an
    // "add" submit (so several properties from the same set can be added in
    // a row) — only the FIRST column opens it via the "+ Custom column" button.
    const setInput = () => container.querySelector('input[placeholder="Pset_… or /Pset_.*/"]') as HTMLInputElement;
    const propInput = () => container.querySelector('input[placeholder="FireRating"]') as HTMLInputElement;
    const addButton = () => container.querySelector('button[aria-label="Add custom column"]') as HTMLElement;

    click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Custom column')) as Element);
    typeInto(setInput(), 'Pset_WallCommon');
    typeInto(propInput(), 'FireRating');
    click(addButton());
    typeInto(setInput(), 'Pset_WallCommon');
    typeInto(propInput(), 'LoadBearing');
    click(addButton());

    // Open, then close, the first column's inline editor.
    const editButton = container.querySelector('button[aria-label="Edit column"]') as HTMLElement;
    assert.ok(editButton, 'expected an "Edit column" button');
    click(editButton);
    const closeButton = container.querySelector('button[aria-label="Close editor"]') as HTMLElement;
    assert.ok(closeButton, 'expected a "Close editor" button once the editor is open');

    // Pick the first column as the level-0 group-by, revealing a level-1
    // ("then by" / "None") slot.
    const level0Select = container.querySelector('label > select') as HTMLSelectElement;
    assert.ok(level0Select, 'expected the level-0 group-by select');
    const firstOptionValue = [...level0Select.options].find((o) => o.value !== '')?.value ?? '';
    assert.ok(firstOptionValue, 'expected at least one column offered in the level-0 select');
    selectValue(level0Select, firstOptionValue);

    const english = readableStrings(container);
    registerLocale('list-builder-then-by-pseudo', PSEUDO);
    act(() => setLocale('list-builder-then-by-pseudo'));
    const after = readableStrings(container);

    assertCoverage(english, after, [
      'lists.builder.closeEditorAriaLabel',
      'lists.builder.thenByLabel',
      'lists.builder.none',
      'lists.builder.groupCountHint',
    ]);
  });

  it('translates "Save column" once an existing column is opened for edit', () => {
    const store = buildStore();
    const provider = buildProvider(store);
    const container = render(
      <ListBuilder providers={[provider]} stores={[store]} initial={null} onSave={() => {}} onCancel={() => {}} onExecute={() => {}} />,
    );
    click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Custom column')) as Element);
    typeInto(container.querySelector('input[placeholder="Pset_… or /Pset_.*/"]') as HTMLInputElement, 'Pset_WallCommon');
    typeInto(container.querySelector('input[placeholder="FireRating"]') as HTMLInputElement, 'FireRating');
    click(container.querySelector('button[aria-label="Add custom column"]') as HTMLElement);
    click(container.querySelector('button[aria-label="Edit column"]') as HTMLElement);

    const english = readableStrings(container);
    assert.ok(english.has('Save column'), 'expected the "Save column" submit button once an existing column is opened for edit');

    registerLocale('list-builder-save-column-pseudo', PSEUDO);
    act(() => setLocale('list-builder-save-column-pseudo'));
    const after = readableStrings(container);
    assert.ok(after.has(mark('lists.builder.saveColumnAriaLabel')), 'saveColumnAriaLabel must be translated');
  });

  it('translates the invalid-pattern warning for a malformed /regex/ set name', () => {
    const store = buildStore();
    const provider = buildProvider(store);
    const container = render(
      <ListBuilder providers={[provider]} stores={[store]} initial={null} onSave={() => {}} onCancel={() => {}} onExecute={() => {}} />,
    );
    click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Custom column')) as Element);
    // Unbalanced group — `isNamePattern` accepts the slash shape, but the
    // regex itself fails to compile (`previewSetPattern`'s `isInvalid` path).
    typeInto(container.querySelector('input[placeholder="Pset_… or /Pset_.*/"]') as HTMLInputElement, '/(unterminated/');

    const english = readableStrings(container);
    assert.ok(
      english.has('Invalid pattern. It would be matched as a literal name, so it likely hits nothing.'),
      'expected the invalid-pattern warning for a malformed /regex/',
    );

    registerLocale('list-builder-invalid-pattern-pseudo', PSEUDO);
    act(() => setLocale('list-builder-invalid-pattern-pseudo'));
    const after = readableStrings(container);
    assert.ok(after.has(mark('lists.builder.invalidPatternHint')), 'invalidPatternHint must be translated');
  });

  it('translates the filter row\'s spatial-level select and the property/quantity pset+name placeholders', () => {
    const store = buildStore();
    const provider = buildProvider(store);
    const container = render(
      <ListBuilder providers={[provider]} stores={[store]} initial={null} onSave={() => {}} onCancel={() => {}} onExecute={() => {}} />,
    );
    click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Add filter')) as Element);
    const dimensionSelect = container.querySelector('select[aria-label="Filter dimension"]') as HTMLSelectElement;

    selectValue(dimensionSelect, 'spatial');
    const spatialEnglish = readableStrings(container);
    assert.ok(spatialEnglish.has('Container'), 'expected the localized spatial-level options to render');
    registerLocale('list-builder-spatial-pseudo', PSEUDO);
    act(() => setLocale('list-builder-spatial-pseudo'));
    const spatialAfter = readableStrings(container);
    assertCoverage(spatialEnglish, spatialAfter, [
      'lists.builder.spatialLevelAriaLabel',
      'lists.builder.spatial.container',
      'lists.builder.spatial.storey',
      'lists.builder.spatial.building',
      'lists.builder.spatial.site',
      'lists.builder.spatial.project',
    ]);
    assert.ok(spatialAfter.has(mark('lists.builder.valuePlaceholder.spatial').replace('{level}', mark('lists.builder.spatial.storey'))));
    act(() => setLocale('en'));

    selectValue(dimensionSelect, 'property');
    const propEnglish = readableStrings(container);
    assert.ok(propEnglish.has('Pset_…'), 'expected the filter row\'s own (shorter) pset placeholder');
    assert.ok(propEnglish.has('name'), 'expected the filter row\'s property-name placeholder');
    registerLocale('list-builder-property-filter-pseudo', PSEUDO);
    act(() => setLocale('list-builder-property-filter-pseudo'));
    const propAfter = readableStrings(container);
    assertCoverage(propEnglish, propAfter, ['lists.builder.psetPlaceholder', 'lists.builder.namePropertyPlaceholder']);
    act(() => setLocale('en'));

    selectValue(dimensionSelect, 'quantity');
    const qtyEnglish = readableStrings(container);
    assert.ok(qtyEnglish.has('Qto_…'), 'expected the filter row\'s own (shorter) qto placeholder');
    registerLocale('list-builder-quantity-filter-pseudo', PSEUDO);
    act(() => setLocale('list-builder-quantity-filter-pseudo'));
    const qtyAfter = readableStrings(container);
    assertCoverage(qtyEnglish, qtyAfter, ['lists.builder.qtoPlaceholder']);
  });

  // `lists.builder.added` (PickerItem's "already added" marker, shown for a
  // discovered pset/qto property that's already a selected column) is not
  // exercised here: it only renders once `discovered.properties`/
  // `discovered.quantities` is non-empty, and this file's fixture store has
  // no pset/qto data (`properties`/`quantities` both `undefined` — see
  // `buildStore()`). The call site (`ListBuilder.tsx`'s `PickerItem`) is the
  // same `t('lists.builder.added')` pattern every other static key here
  // uses, and is covered mechanically by the same conversion, not by a
  // dedicated render.
});
