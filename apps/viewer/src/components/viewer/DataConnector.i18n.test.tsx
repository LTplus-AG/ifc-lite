/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `DataConnector`'s own chrome reads the i18n catalogue (#4918 slice,
 * `data-connector.en.ts`, prefix `dataConnector.*`): the trigger button,
 * dialog header and step indicator, the target-model and CSV-file pickers,
 * the data-preview caption, the entity-matching controls, the
 * property-mapping list, the match-results/import-complete/error alerts,
 * and the footer's preview/import buttons.
 *
 * The oracle is a pseudo-locale that marks every `dataConnector.*` key with
 * a `⟦…⟧` wrapper. Each scenario below drives the component into one real
 * DOM state (a basic CSV preview with no model selected, a connected model
 * with matched/unmatched/multi-match rows, a broken model whose mutation
 * view never resolves, a viewer-role collab session, and the default
 * trigger), captures the readable strings, switches the active locale to
 * the pseudo catalogue, and asserts the marked form takes over — the same
 * shape `RepositionPanel.i18n.test.tsx` uses. CSV column NAMES, sample cell
 * VALUES, and model NAMES are runtime content asserted separately from the
 * catalogue keys, never hardcoded as expected translations here.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, activate, advance } from '@/test/render.js';
import { registerLocale, setLocale, localeCount, type Catalogue } from '@/i18n';
import { resolve } from '@/i18n/registry';
import { en } from '@/i18n/en';
import type { TranslationParameters, TranslationValue, PluralTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { DataConnector } from './DataConnector';

const CATALOGUE: Catalogue = Object.fromEntries(
  Object.entries(en).filter(([key]) => key.startsWith('dataConnector.')),
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
const PSEUDO_LOCALE = 'data-connector-pseudo';

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

function foundText(strings: Set<string>, text: string): boolean {
  if (strings.has(text)) return true;
  for (const s of strings) {
    if (s.includes(text)) return true;
  }
  return false;
}

interface Occurrence {
  key: string;
  params?: TranslationParameters;
}

const covered = new Set<string>();

/** Snapshot the current DOM, switch to the pseudo locale, snapshot again, and
 *  assert every occurrence's resolved text is present both before and after
 *  — then switch back to English so the next action starts from a known
 *  state. Tracks every key it checks in `covered` for the final accounting. */
function checkAtCurrentState(occurrences: Occurrence[]): void {
  const englishDom = readableStrings(document.body);
  const beforeTexts = occurrences.map((occ) => resolve(occ.key as never, occ.params).trim());
  act(() => setLocale(PSEUDO_LOCALE));
  const afterDom = readableStrings(document.body);
  occurrences.forEach((occ, i) => {
    assert.ok(
      foundText(englishDom, beforeTexts[i]),
      `${occ.key}: expected English text ${JSON.stringify(beforeTexts[i])} before the locale switch`,
    );
    const pseudo = resolve(occ.key as never, occ.params).trim();
    assert.ok(
      foundText(afterDom, pseudo),
      `${occ.key}: "${pseudo}" must be translated, marked text not found after the locale switch`,
    );
    covered.add(occ.key);
  });
  act(() => setLocale(BASELINE_LOCALE));
}

function comboboxTriggers(): HTMLElement[] {
  return [...document.body.querySelectorAll('[role="combobox"]')] as HTMLElement[];
}

function openSelect(trigger: HTMLElement): HTMLElement[] {
  act(() => {
    trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  });
  return [...document.body.querySelectorAll('[role="option"]')] as HTMLElement[];
}

function closeSelect(trigger: HTMLElement): void {
  act(() => {
    trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
}

function chooseOption(options: HTMLElement[], label: string): void {
  const option = options.find((o) => o.textContent?.includes(label));
  assert.ok(option, `option "${label}" must be offered`);
  act(() => {
    option!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
}

async function openDialog(): Promise<HTMLElement> {
  const container = render(<DataConnector trigger={<button>Open</button>} />);
  const trigger = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Open'));
  assert.ok(trigger, 'dialog trigger must render');
  click(trigger!);
  await advance(0);
  return container;
}

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await advance(0);
}

/** Upload a CSV into the hidden file input and wait for `FileReader`'s
 *  async `onload` (happy-dom fires it on a later macrotask) to run the
 *  component's parse logic to completion. */
async function uploadCsv(text: string): Promise<void> {
  const input = document.body.querySelector('input[type="file"]') as HTMLInputElement | null;
  assert.ok(input, 'expected the hidden CSV file input');
  const file = new File([text], 'import.csv', { type: 'text/csv' });
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  Object.defineProperty(input, 'files', { value: dataTransfer.files, configurable: true });
  act(() => {
    input!.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  registerLocale(PSEUDO_LOCALE, PSEUDO);
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState({
    models: new Map(),
    activeModelId: null,
    ifcDataStore: null,
    geometryResult: null,
    mutationViews: new Map(),
    mutationVersion: 0,
    collabRole: null,
  });
});

afterEach(() => {
  cleanup();
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState({
    models: new Map(),
    activeModelId: null,
    ifcDataStore: null,
    geometryResult: null,
    mutationViews: new Map(),
    mutationVersion: 0,
    collabRole: null,
  });
});

describe('DataConnector localization (#4918)', () => {
  it('#5823 opens the CSV picker from the upload control with Enter and Space', async () => {
    await openDialog();
    const upload = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Drag & drop a CSV file'));
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');
    assert.ok(upload && input);
    let opens = 0;
    input.addEventListener('click', () => { opens++; });
    activate(upload, 'Enter');
    activate(upload, ' ');
    assert.equal(opens, 2);
  });

  it('translates the default trigger button when no custom trigger is supplied', async () => {
    render(<DataConnector />);
    checkAtCurrentState([{ key: 'dataConnector.triggerButton' }]);
  });

  it('translates the header, model/CSV pickers, error alert, and basic-parse preview chrome', async () => {
    await openDialog();

    checkAtCurrentState([
      { key: 'dataConnector.dialogTitle' },
      { key: 'dataConnector.dialogDescription' },
      { key: 'dataConnector.step.upload' },
      { key: 'dataConnector.step.configure' },
      { key: 'dataConnector.step.import' },
      { key: 'dataConnector.targetModelLabel' },
      { key: 'dataConnector.selectModelPlaceholder' },
      { key: 'dataConnector.csvFileLabel' },
      { key: 'dataConnector.dragDropText' },
      { key: 'dataConnector.clickToBrowseText' },
    ]);

    // A real CSV with no "globalid"/"guid"-like column name leaves
    // matchColumn empty, so the CSV-column placeholder renders instead of a
    // chosen value. The Error/Match-Results/Import-Complete alerts all sit
    // inside the same `csvColumns.length > 0` fragment as this preview, so
    // a successful parse has to happen first before any of them can show.
    await uploadCsv('ID,Description\n1,Alpha\n2,Beta\n');
    checkAtCurrentState([
      { key: 'dataConnector.changeFileButton' },
      { key: 'dataConnector.dataPreviewLabel' },
      { key: 'dataConnector.sampleRowsCount', params: localeCount('en', 2) },
      { key: 'dataConnector.entityMatchingLabel' },
      { key: 'dataConnector.matchByLabel' },
      { key: 'dataConnector.csvColumnLabel' },
      { key: 'dataConnector.selectColumnPlaceholder' },
      { key: 'dataConnector.propertyMappingsLabel' },
      { key: 'dataConnector.addMappingButton' },
      { key: 'dataConnector.noMappingsText' },
      { key: 'dataConnector.noMappingsHint' },
      { key: 'dataConnector.importButton' },
      { key: 'dataConnector.previewMatchesButton' },
    ]);

    // A header-only re-upload hits the basic-parse error path; the Error
    // alert sits in the same `csvColumns.length > 0` fragment already
    // rendered above, so it shows alongside the stale preview from before.
    await uploadCsv('ID,Description\n');
    checkAtCurrentState([{ key: 'dataConnector.errorTitle' }]);

    // Open the CSV-column select: its per-option sample hint.
    let triggers = comboboxTriggers();
    openSelect(triggers[2]);
    checkAtCurrentState([{ key: 'dataConnector.columnSampleHint', params: { sample: '1' } }]);
    closeSelect(comboboxTriggers()[2]);

    // Open the match-by select without committing a new choice.
    triggers = comboboxTriggers();
    openSelect(triggers[1]);
    checkAtCurrentState([
      { key: 'dataConnector.matchTypeGlobalId' },
      { key: 'dataConnector.matchTypeExpressId' },
      { key: 'dataConnector.matchTypeEntityName' },
      { key: 'dataConnector.matchTypePropertyValue' },
    ]);
    closeSelect(comboboxTriggers()[1]);

    // Add one empty mapping row: column headers, per-row placeholders, and
    // the value-type options.
    const addButton = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === resolve('dataConnector.addMappingButton' as never),
    );
    assert.ok(addButton, 'expected the Add mapping button');
    click(addButton!);

    checkAtCurrentState([
      { key: 'dataConnector.sourceColumnHeader' },
      { key: 'dataConnector.targetPsetHeader' },
      { key: 'dataConnector.targetPropertyHeader' },
      { key: 'dataConnector.typeHeader' },
      { key: 'dataConnector.columnPlaceholder' },
      { key: 'dataConnector.psetNamePlaceholder' },
      { key: 'dataConnector.propertyPlaceholder' },
      { key: 'dataConnector.removeMappingLabel' },
    ]);

    triggers = comboboxTriggers();
    const valueTypeTrigger = triggers[triggers.length - 1];
    openSelect(valueTypeTrigger);
    checkAtCurrentState([
      { key: 'dataConnector.valueTypeString' },
      { key: 'dataConnector.valueTypeReal' },
      { key: 'dataConnector.valueTypeInteger' },
      { key: 'dataConnector.valueTypeBoolean' },
    ]);
    closeSelect(comboboxTriggers()[triggers.length - 1]);

    // Commit "Property Value" on the match-by select to reveal the
    // property-set / property-name fields.
    triggers = comboboxTriggers();
    const matchByOptions = openSelect(triggers[1]);
    chooseOption(matchByOptions, 'Property Value');
    checkAtCurrentState([
      { key: 'dataConnector.propertySetFieldLabel' },
      { key: 'dataConnector.propertySetPlaceholder' },
      { key: 'dataConnector.propertyNameFieldLabel' },
      { key: 'dataConnector.propertyNamePlaceholder' },
    ]);
  });

  it('translates the match-results and import-complete alerts once a real model is connected', async () => {
    const modelA = fixtureModel('model-a', {
      entities: [
        { expressId: 1, type: 'IfcWall', name: 'Wall A', globalId: 'GUID-A' },
        { expressId: 2, type: 'IfcWall', name: 'Wall B', globalId: 'GUID-B' },
        { expressId: 3, type: 'IfcWall', name: 'Wall C', globalId: 'DUP-GUID' },
        { expressId: 4, type: 'IfcWall', name: 'Wall D', globalId: 'DUP-GUID' },
      ],
    });
    const modelB = fixtureModel('model-b', { entities: [] });
    useViewerStore.setState({
      models: new Map([
        ['model-a', modelA],
        ['model-b', modelB],
      ]),
      activeModelId: 'model-a',
      mutationViews: new Map(),
      mutationVersion: 0,
      collabRole: null,
    });

    await openDialog();
    await settle();

    // The panel auto-selects "model-a" before its mutation view exists, and
    // the connector memo only reads the registry once per `selectedModelId`
    // change (it isn't subscribed to the mutation-view store slice) — so
    // the very first selection always computes a null connector even after
    // the view finishes registering. Bouncing the Target Model select away
    // and back is a real user action that forces a fresh read once the
    // view is actually there.
    let triggers = comboboxTriggers();
    let modelOptions = openSelect(triggers[0]);
    chooseOption(modelOptions, 'model-b');
    await settle();
    triggers = comboboxTriggers();
    modelOptions = openSelect(triggers[0]);
    chooseOption(modelOptions, 'model-a');
    await settle();

    // A single-column CSV whose only column is the GlobalId match column
    // itself: auto-detect finds no property mapping, so a manual empty row
    // (added below) deterministically contributes zero mutations.
    await uploadCsv('GlobalId\nGUID-A\nDUP-GUID\nUNKNOWN-GUID\n');

    // A connected model parses through `CsvConnector.parse`, which
    // populates `parsedRows` — the "N rows parsed" branch, not the
    // connector-less "N sample rows" one `rowsParsedCount`'s sibling
    // key covers in the earlier scenario.
    checkAtCurrentState([
      { key: 'dataConnector.autoDetectButton' },
      { key: 'dataConnector.rowsParsedCount', params: localeCount('en', 3) },
    ]);

    const addButton = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === resolve('dataConnector.addMappingButton' as never),
    );
    assert.ok(addButton, 'expected the Add mapping button once a model is connected');
    click(addButton!);

    const previewButton = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.includes(resolve('dataConnector.previewMatchesButton' as never)),
    );
    assert.ok(previewButton, 'expected the Preview Matches button');
    click(previewButton!);
    await settle();

    // GUID-A matches entity 1 alone (high confidence); DUP-GUID matches
    // entities 3 and 4 (a multi-match); UNKNOWN-GUID matches nothing.
    checkAtCurrentState([
      { key: 'dataConnector.matchResultsTitle' },
      { key: 'dataConnector.matchedCount', params: localeCount('en', 2) },
      { key: 'dataConnector.unmatchedCount', params: localeCount('en', 1) },
      { key: 'dataConnector.highConfidenceCount', params: localeCount('en', 1) },
      { key: 'dataConnector.multiMatchCount', params: localeCount('en', 1) },
      { key: 'dataConnector.importRowsButton', params: localeCount('en', 2) },
    ]);

    const importButton = [...document.body.querySelectorAll('button')].find((b) =>
      /^(Import|Import \d+ rows)$/.test(b.textContent?.trim() ?? ''),
    );
    assert.ok(importButton, 'expected the footer Import button');
    click(importButton!);
    await settle(10);

    checkAtCurrentState([
      { key: 'dataConnector.importCompleteTitle' },
      { key: 'dataConnector.propertiesUpdatedCount', params: localeCount('en', 0) },
      { key: 'dataConnector.rowsMatchedCount', params: localeCount('en', 2) },
      { key: 'dataConnector.rowsUnmatchedCount', params: localeCount('en', 1) },
    ]);
  });

  it('translates the mutation-view-unavailable note for a model with no ifcDataStore', async () => {
    const brokenModel = {
      id: 'broken',
      name: 'Broken',
      visible: true,
      collapsed: false,
      idOffset: 0,
      ifcDataStore: null,
      geometryResult: null,
    } as unknown as FederatedModel;
    useViewerStore.setState({
      ...fixtureModels(brokenModel),
      mutationViews: new Map(),
      mutationVersion: 0,
      collabRole: null,
    });

    await openDialog();
    await settle();

    checkAtCurrentState([{ key: 'dataConnector.mutationViewUnavailableNote' }]);
  });

  it('translates the collab-restricted Import button title for a viewer-role session', async () => {
    const model = fixtureModel('model-a', {
      entities: [{ expressId: 1, type: 'IfcWall', name: 'Wall A' }],
    });
    useViewerStore.setState({
      ...fixtureModels(model),
      mutationViews: new Map(),
      mutationVersion: 0,
      collabRole: 'viewer',
    });

    await openDialog();
    await settle();

    checkAtCurrentState([{ key: 'dataConnector.editRequiresAccessTitle' }]);
  });

  it('accounts for every catalogue key: rendered above, or a documented other-branch', () => {
    // Keys this suite's fixtures cannot reach, each for a stated reason:
    const NOT_RENDERED: string[] = [
      // Only shown while `isDragging` is true — a live HTML5 drag-and-drop
      // gesture, not something these DOM-event-driven tests simulate.
      'dataConnector.dropHereText',
      // Live `importAsync` progress phases/counters: this component's
      // upload flow resolves within one or two microtask yields in a unit
      // test, so the transient "Parsing CSV.../Matching entities.../
      // Applying properties..." line and its optional written-count suffix
      // are never observably on screen between click and completion.
      'dataConnector.phaseParsing',
      'dataConnector.phaseMatching',
      'dataConnector.phaseApplying',
      'dataConnector.writtenSuffix',
      // The connected-model fixture's import produces zero warnings (every
      // CSV row carries a match value), so the warning-count line never
      // mounts.
      'dataConnector.warningsCount',
    ];

    const unaccounted = KEYS.filter((key) => !covered.has(key) && !NOT_RENDERED.includes(key));
    assert.deepEqual(unaccounted, [], 'key neither exercised by a scenario above nor listed in NOT_RENDERED');

    const stale = NOT_RENDERED.filter((key) => covered.has(key));
    assert.deepEqual(stale, [], 'key listed as not-rendered but was actually exercised above — drop it from the list');
  });
});
