/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ValidationPanel` end-to-end wiring (#5138 plan §9 PR 4):
 *
 * - the "IDS validation" entry card mounts the existing, unmodified
 *   `IDSPanel` (its own empty state renders through `ValidationPanel`);
 * - the "Information validation" entry opens a real `.rules.json` file
 *   through the real file-input path, runs it with the real
 *   `runRuleSet` engine against a real parsed IFC model, and lands a
 *   `source.kind: 'rules'` report in the store that the generalised
 *   `IDSPanelResults`/`SpecificationCard` render.
 *
 * Both walls in the fixture share the same `Name` on purpose, so the
 * two-rule fixture exercises an `element` requirement (FireRating set/not
 * set) AND a `unique` requirement (one duplicate group) in the same run —
 * the results state this test checks is driven by a report the engine
 * actually produced, not a hand-built fixture.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { IDSDocument } from '@ifc-lite/ids';
import { advance, cleanup, click, mouseDown, press, render, type as typeInput } from '@/test/render.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { addRecentRuleSet } from '@/lib/validation/recent-rule-sets';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { ValidationPanel } from './ValidationPanel.js';

const WALLS_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000001',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#401= IFCWALL('0WallA0000000000000001A',$,'Wall',$,$,#40,$,'tag',$);
#410= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('2HR'),$);
#412= IFCPROPERTYSET('0Pset00000000000000412A',$,'Pset_WallCommon',$,(#410));
#413= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000413A',$,$,$,(#401),#412);
#402= IFCWALL('0WallB0000000000000002A',$,'Wall',$,$,#40,$,'tag',$);
ENDSEC;
END-ISO-10303-21;
`;

const RULE_SET_JSON = JSON.stringify({
  version: 1,
  name: 'Wiring fixture',
  rules: [
    {
      id: 'r1',
      name: 'Fire rating set',
      applicability: { groups: [{ rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }], combinator: 'AND' }], authoredAs: 'chips' },
      requirement: {
        kind: 'element',
        block: { groups: [{ rules: [{ kind: 'property', setName: 'Pset_WallCommon', propertyName: 'FireRating', op: 'isSet', value: '' }], combinator: 'AND' }], authoredAs: 'chips' },
      },
    },
    {
      id: 'r2',
      name: 'Unique name',
      applicability: { groups: [{ rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }], combinator: 'AND' }], authoredAs: 'chips' },
      requirement: { kind: 'unique', subject: { kind: 'attribute', name: 'Name' } },
    },
  ],
});

async function parseWalls(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(WALLS_IFC);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function federatedModel(id: string, store: IfcDataStore): FederatedModel {
  return {
    id, name: `${id}.ifc`, ifcDataStore: store, geometryResult: null, visible: true,
    collapsed: false, schemaVersion: 'IFC4', loadedAt: 0, fileSize: 0, idOffset: 0, maxExpressId: 10000,
  } as unknown as FederatedModel;
}

function ruleSetFile(): File {
  return new File([RULE_SET_JSON], 'fixture.rules.json', { type: 'application/json' });
}

function idsDocumentFixture(): IDSDocument {
  return {
    info: { title: 'Wiring IDS fixture', version: '1.0' },
    specifications: [{
      id: 'spec-a', name: 'Wall requirements', ifcVersions: ['IFC4'],
      applicability: { facets: [] }, requirements: [],
    }],
  };
}

async function selectFile(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Poll `condition` until true or a generous timeout — the engine run is a
 *  real async `runRuleSet` over the parsed store, not something a single
 *  microtask flush settles. */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true');
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}

const initial = useViewerStore.getState();

afterEach(() => {
  cleanup();
  setValidationSourceChoice(null);
  useViewerStore.setState({
    ...initial,
    models: new Map(),
    idsDocument: null,
    idsValidationReport: null,
    validationSource: null,
    idsAuditReport: null,
    idsError: null,
    idsLoading: false,
    idsProgress: null,
  });
});

describe('ValidationPanel wiring (#5138)', () => {
  it('#5815 ArrowRight selects Information validation and labels its panel', async () => {
    setValidationSourceChoice('ids');
    const ui = render(<ValidationPanel />);
    const tabs = [...ui.querySelectorAll<HTMLElement>('[role="tab"]')];
    assert.equal(tabs.length, 2);
    tabs[0].focus();
    press(tabs[0], 'ArrowRight');
    await advance(5);
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
    assert.equal(document.activeElement, tabs[1]);
    const panel = ui.querySelector('[role="tabpanel"][data-state="active"]');
    assert.ok(panel);
    assert.equal(panel.getAttribute('aria-labelledby'), tabs[1].id);
  });

  for (const modelCount of [1, 2]) {
    it(`keeps an unsaved rule-set draft and edit mode across remount with ${modelCount} model(s) (#5825)`, async () => {
      const parsed = await parseWalls();
      useViewerStore.setState({
        models: new Map(Array.from({ length: modelCount }, (_, index) => {
          const id = `m${index + 1}`;
          return [id, federatedModel(id, parsed)] as const;
        })),
      });

      const first = render(<ValidationPanel />);
      const fileInput = first.querySelector('input[type="file"]');
      assert.ok(fileInput);
      await selectFile(fileInput as HTMLInputElement, ruleSetFile());
      await waitFor(() => first.querySelector('input[aria-label="Rule set name"]') !== null);
      const nameInput = first.querySelector('input[aria-label="Rule set name"]') as HTMLInputElement | null;
      assert.ok(nameInput);
      typeInput(nameInput, 'Unsaved draft');
      assert.strictEqual(nameInput.value, 'Unsaved draft');

      cleanup(); // Switching to another sidebar panel unmounts the host.
      const reopened = render(<ValidationPanel onClose={() => {}} />);
      const restoredName = reopened.querySelector('input[aria-label="Rule set name"]') as HTMLInputElement | null;
      assert.ok(restoredName, 'the editor must reopen rather than the empty-state entry');
      assert.strictEqual(restoredName.value, 'Unsaved draft');
      assert.deepStrictEqual(
        [...reopened.querySelectorAll<HTMLInputElement>('input[aria-label="Rule name"]')].map((input) => input.value),
        ['Fire rating set', 'Unique name'],
      );

      const close = reopened.querySelector('button[aria-label="Data validation"]');
      assert.ok(close);
      click(close);
      cleanup();
      const afterClose = render(<ValidationPanel />);
      assert.strictEqual(afterClose.querySelector('input[aria-label="Rule set name"]'), null);
      assert.match(afterClose.textContent ?? '', /New rule set/);
    });
  }

  it('full model unload discards the unsaved rule-set draft (#5825)', async () => {
    const parsed = await parseWalls();
    useViewerStore.setState({ models: new Map([['m1', federatedModel('m1', parsed)]]) });
    const first = render(<ValidationPanel />);
    const fileInput = first.querySelector('input[type="file"]');
    assert.ok(fileInput);
    await selectFile(fileInput as HTMLInputElement, ruleSetFile());
    cleanup();

    useViewerStore.getState().clearAllModels();
    const reopened = render(<ValidationPanel />);
    assert.strictEqual(reopened.querySelector('input[aria-label="Rule set name"]'), null);
    assert.match(reopened.textContent ?? '', /New rule set/);
  });

  it('the IDS validation entry card mounts the existing IDSPanel empty state', () => {
    const ui = render(<ValidationPanel />);
    const entry = ui.querySelector('[data-testid="validation-entry-ids"]');
    assert.ok(entry, 'expected the IDS validation entry card');
    click(entry as Element);
    // IDSPanel's own title is suppressed when embedded (ValidationPanel's
    // header + toggle is the only chrome) — its EMPTY-STATE BODY still is.
    assert.match(ui.textContent ?? '', /No IDS Loaded/);
    assert.match(ui.textContent ?? '', /Load an IDS/);
  });

  it('opening and running a real two-rule rule set lands a source.kind: "rules" report the panel renders', async () => {
    const store = await parseWalls();
    useViewerStore.setState({ models: new Map([['m1', federatedModel('m1', store)]]) });

    const ui = render(<ValidationPanel />);
    const fileInput = ui.querySelector('input[type="file"]');
    assert.ok(fileInput, 'expected the "Open .rules.json" hidden file input');
    await selectFile(fileInput as HTMLInputElement, ruleSetFile());

    // Authoring state: the Run button is enabled once the 2-rule file loads.
    await waitFor(() => {
      const run = [...ui.querySelectorAll('button')].find((b) => b.textContent === 'Run');
      return run !== undefined && !run.disabled;
    });
    const runButton = [...ui.querySelectorAll('button')].find((b) => b.textContent === 'Run');
    assert.ok(runButton);
    click(runButton!);

    await waitFor(() => useViewerStore.getState().idsValidationReport !== null);

    const report = useViewerStore.getState().idsValidationReport;
    assert.ok(report);
    assert.strictEqual(report!.source.kind, 'rules');
    assert.strictEqual(report!.specificationResults.length, 2);

    const text = ui.textContent ?? '';
    assert.match(text, /Fire rating set/);
    assert.match(text, /Unique name/);
    // Rule 1: 2 applicable walls, 1 passes (FireRating set), 1 fails.
    const rule1 = report!.specificationResults.find((r) => r.specification.name === 'Fire rating set');
    assert.ok(rule1);
    assert.strictEqual(rule1!.applicableCount, 2);
    assert.strictEqual(rule1!.passedCount, 1);
    assert.strictEqual(rule1!.failedCount, 1);
    // Rule 2: both walls share Name -> one duplicate SetResult.
    const rule2 = report!.specificationResults.find((r) => r.specification.name === 'Unique name');
    assert.ok(rule2);
    assert.strictEqual(rule2!.setResults?.length, 1);
    assert.strictEqual(rule2!.setResults?.[0]?.passed, false);

    // "Edit rules" is offered from the results state, keeping the report.
    assert.match(text, /Edit rules/);
    const editRules = [...ui.querySelectorAll('button')].find((button) => button.textContent === 'Edit rules');
    assert.ok(editRules);
    click(editRules);
    cleanup();
    const reopened = render(<ValidationPanel />);
    const restoredName = reopened.querySelector('input[aria-label="Rule set name"]') as HTMLInputElement | null;
    assert.ok(restoredName, 'edit mode must survive the panel unmount even while a report exists (#5825)');
    assert.strictEqual(restoredName.value, 'Wiring fixture');
  });

  it('the header toggle switches sources without losing either side\'s state', () => {
    useViewerStore.setState({ idsDocument: idsDocumentFixture() });
    const ui = render(<ValidationPanel />);

    // An IDS document is loaded, so the panel defaults to the IDS side.
    assert.match(ui.textContent ?? '', /Wiring IDS fixture/);

    const rulesToggle = [...ui.querySelectorAll('button[role="tab"]')].find((b) => b.textContent === 'Information validation');
    assert.ok(rulesToggle, 'expected the "Information validation" toggle button');
    mouseDown(rulesToggle!);

    // No rule set loaded yet on this side — the New/Open entry, not a blank pane.
    assert.match(ui.textContent ?? '', /New rule set/);
    assert.match(ui.textContent ?? '', /Open \.rules\.json/);
    assert.doesNotMatch(ui.textContent ?? '', /Wiring IDS fixture/, 'the IDS document title must not leak into the rules side');

    const idsToggle = [...ui.querySelectorAll('button[role="tab"]')].find((b) => b.textContent === 'IDS validation');
    assert.ok(idsToggle);
    mouseDown(idsToggle!);

    // Toggling back: the IDS document is still there, untouched by the round trip.
    assert.match(ui.textContent ?? '', /Wiring IDS fixture/);
    assert.strictEqual(useViewerStore.getState().idsDocument?.info.title, 'Wiring IDS fixture');
  });

  it('a corrupt "Recent rule sets" entry reports an error and is dropped, not silently ignored', () => {
    addRecentRuleSet('Corrupt entry', '{not valid json');
    const ui = render(<ValidationPanel />);
    const recentButton = [...ui.querySelectorAll('button')].find((b) => b.textContent?.includes('Corrupt entry'));
    assert.ok(recentButton, 'expected the corrupt entry to still be listed under Recent rule sets');
    click(recentButton!);

    assert.match(ui.textContent ?? '', /could not be loaded/);
    // Dropped from the cache — a second render doesn't offer it again.
    const rerendered = render(<ValidationPanel />);
    assert.strictEqual(
      [...rerendered.querySelectorAll('button')].some((b) => b.textContent?.includes('Corrupt entry')),
      false,
      'the corrupt entry must be removed from Recent rule sets after failing to load',
    );
  });
});
