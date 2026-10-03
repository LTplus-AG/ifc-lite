/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { installResizablePanelLayout } from '@/test/dom-layout.js';
import { after, afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS, validateIDS, type ValidationReport } from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { advance, cleanup, click, mouseDown, press, render, waitFor } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { loadDefinitionLibrary } from '@/lib/validation/definition-library';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { ValidationPanel } from './ValidationPanel.js';

after(installResizablePanelLayout());

// #6690 invariant: twelve checks each validate two parsed walls: A passes,
// B fails. These are actual validator/engine reports, not a mocked hook.
// Measured DOM stubs prove interaction and pane ownership, not CSS scrolling.
const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Synthetic resizing invariant'),'2;1');
FILE_NAME('synthetic.ifc','2026-01-01T00:00:00',(),(),'Test','Test','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('0Wall00000000000000001',$,'Wall A',$,$,$,$,'A',.STANDARD.);
#2=IFCWALL('0Wall00000000000000002',$,'Wall B',$,$,$,$,'B',.STANDARD.);
ENDSEC;
END-ISO-10303-21;`;
const specifications = Array.from({ length: 12 }, (_, index) => `
<specification name="Wall tag ${index + 1}" ifcVersion="IFC4" identifier="tag-${index}">
<applicability minOccurs="0" maxOccurs="unbounded">
<entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
</applicability><requirements><attribute cardinality="required">
<name><simpleValue>Tag</simpleValue></name><value><simpleValue>A</simpleValue></value>
</attribute></requirements></specification>`).join('');
const idsXml = `<ids xmlns="http://standards.buildingsmart.org/IDS">
<info><title>Resizing checks</title></info><specifications>${specifications}</specifications></ids>`;
const ids = parseIDS(idsXml);
const ruleSet = JSON.stringify({
  version: 1, name: 'Resizing checks',
  rules: Array.from({ length: 12 }, (_, index) => ({
    id: `tag-${index}`, name: `Wall tag ${index + 1}`,
    applicability: {
      groups: [{ rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }], combinator: 'AND' }],
      authoredAs: 'chips',
    },
    requirement: {
      kind: 'element', block: {
        groups: [{ rules: [{ kind: 'attribute', name: 'Tag', op: 'eq', value: 'A' }], combinator: 'AND' }],
        authoredAs: 'chips',
      },
    },
  })),
});
const initial = useViewerStore.getState();

beforeEach(() => {
  localStorage.clear();
  setValidationSourceChoice(null);
  // Keep the content fixture's initialized storage controllers intact.
  useViewerStore.setState({
    validationDefinitions: loadDefinitionLibrary().library,
    validationRuleSetDraft: null, validationRuleSetEditing: false,
    idsDocument: null, idsValidationReport: null, idsAuditReport: null,
    idsError: null, idsLoading: false, idsProgress: null, validationSource: null,
    idsFilterMode: 'all', idsFocusMode: 'highlight', idsActiveSpecificationId: null,
    idsActiveEntityId: null, manualChecklist: null, manualAnswers: {},
  });
});
afterEach(() => {
  cleanup();
  setValidationSourceChoice(null);
  useViewerStore.setState(initial);
});

function buttonByText(ui: ParentNode, text: string) {
  const found = [...ui.querySelectorAll('button')].find(button => button.textContent?.trim() === text);
  assert.ok(found, `expected button ${text}`);
  return found;
}

async function prepareModels(count: number) {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer);
  const models = Array.from({ length: count }, (_, index) => ({
    ...fixtureModel(`m${index}`, { idOffset: index * 1_000_000 }),
    name: `m${index}.ifc`, ifcDataStore: store, schemaVersion: 'IFC4' as const,
    sourceFingerprint: `model-${index}`,
  }));
  useViewerStore.setState(fixtureModels(...models));
  return store;
}

async function openAndRunRules(ui: HTMLElement) {
  const input = ui.querySelector<HTMLInputElement>('input[type="file"][accept=".rules.json,.json"]');
  assert.ok(input);
  Object.defineProperty(input, 'files', {
    value: [new File([ruleSet], 'resize.rules.json')], configurable: true,
  });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await waitFor(() => [...ui.querySelectorAll('button')].some(button =>
    button.textContent?.trim() === 'Run' && !button.disabled), 'the parsed rule set becomes runnable');
  click(buttonByText(ui, 'Run'));
  await waitFor(() => useViewerStore.getState().idsValidationReport?.source.kind === 'rules',
    'the real rules engine publishes its report');
}

function assertInvariant(report: ValidationReport, modelCount: number) {
  assert.equal(report.specificationResults.length, 12);
  for (const result of report.specificationResults) {
    assert.equal(result.applicableCount, modelCount * 2);
    assert.equal(result.passedCount, modelCount);
    assert.equal(result.failedCount, modelCount);
  }
}

for (const kind of ['ids', 'rules'] as const) {
  for (const modelCount of [1, 2]) {
    it(`${kind} resizing keeps final engine results, selection and tab state with ${modelCount} models (#6690)`, async () => {
      const store = await prepareModels(modelCount);
      setValidationSourceChoice(kind);
      if (kind === 'ids') {
        const report = await validateIDS(ids, createDataAccessor(store),
          { modelId: 'm0', schemaVersion: 'IFC4', entityCount: 2 });
        assert.equal(useViewerStore.getState().addValidationDefinition({ kind: 'ids', xml: idsXml, document: ids }), true);
        useViewerStore.getState().setIdsValidationReport(report);
      }
      const ui = render(<ValidationPanel />);
      if (kind === 'rules') await openAndRunRules(ui);
      const report = useViewerStore.getState().idsValidationReport;
      assert.ok(report);
      assert.equal(report.source.kind, kind);
      assertInvariant(report, kind === 'rules' ? modelCount : 1);
      await advance(0);

      const handle = ui.querySelector<HTMLElement>('[role="separator"][aria-label="Resize validation summary"]');
      const summary = ui.querySelector('[data-validation-summary-pane]');
      const results = ui.querySelector('[data-validation-results-pane]');
      assert.ok(handle && summary && results);
      if (kind === 'ids') {
        // #6690: a fixed IDS header stole 53px outside the split in a 300px
        // dock. The shared actions/status must own the upper scroll pane.
        const selectors = ui.querySelectorAll('select[aria-label="Select IDS document"]');
        assert.equal(selectors.length, 1);
        assert.ok(summary.contains(selectors[0]));
        for (const label of ['Re-run validation', 'Clear results', 'Load New IDS', 'Unload IDS']) {
          const controls = ui.querySelectorAll(`button[aria-label="${label}"]`);
          assert.equal(controls.length, 1, `one shared ${label} action`);
          assert.ok(summary.contains(controls[0]), `${label} belongs to the upper scroll pane`);
        }
      }
      if (kind === 'rules') {
        const selectors = ui.querySelectorAll('select[aria-label="Select rule set"]');
        assert.equal(selectors.length, 1, 'one actual imported definition control is rendered');
        assert.ok(summary.contains(selectors[0]), 'the growing library belongs to the upper scroll pane');
        assert.ok(summary.contains(buttonByText(ui, 'Edit rules')));
      }
      assert.equal(handle.tabIndex, 0);
      assert.equal(handle.getAttribute('aria-orientation'), 'horizontal');
      const startingSize = Number(handle.getAttribute('aria-valuenow'));
      press(handle, 'ArrowUp');
      assert.ok(Number(handle.getAttribute('aria-valuenow')) < startingSize);
      press(handle, 'ArrowDown');
      assert.equal(Number(handle.getAttribute('aria-valuenow')), startingSize);

      // Read the heading itself: "Wall tag 1" followed by "2 entities"
      // concatenates into "Wall tag 12…" in the whole button's textContent.
      const finalCard = [...results.querySelectorAll('button')].find(button =>
        [...button.querySelectorAll('span')].some(label => label.textContent?.trim() === 'Wall tag 12'));
      assert.ok(finalCard);
      const viewport = results.querySelector('[data-radix-scroll-area-viewport]');
      assert.ok(viewport?.contains(finalCard), 'the final card belongs to the lower scroll viewport');
      assert.equal(summary.contains(finalCard), false);
      click(finalCard);
      assert.equal(useViewerStore.getState().idsActiveSpecificationId, report.specificationResults[11].specification.id);
      const failedRow = results.querySelector<HTMLButtonElement>('button[aria-label="Wall B - IfcWall - Failed"]');
      assert.ok(failedRow);
      click(failedRow);
      assert.deepEqual(useViewerStore.getState().idsActiveEntityId, { modelId: 'm0', expressId: 2 });
      assert.equal(useViewerStore.getState().idsValidationReport, report);

      const tab = (name: string) => {
        const found = [...ui.querySelectorAll<HTMLElement>('[role="tab"]')].find(element => element.textContent === name);
        assert.ok(found);
        return found;
      };
      mouseDown(tab('Manual validation'));
      mouseDown(tab(kind === 'ids' ? 'IDS validation' : 'Information validation'));
      assert.equal(useViewerStore.getState().idsValidationReport, report);
      const restoredResults = ui.querySelector('[data-validation-results-pane]');
      assert.ok(restoredResults?.textContent?.includes('Wall tag 12'));

      if (kind === 'ids') {
        const rerun = ui.querySelector<HTMLButtonElement>('button[aria-label="Re-run validation"]');
        assert.ok(rerun);
        click(rerun);
        const runningSummary = ui.querySelector('[data-validation-summary-pane]');
        const cancel = ui.querySelector('button[aria-label="Cancel validation"]');
        const progress = ui.querySelector('output');
        assert.ok(runningSummary && cancel && progress);
        assert.ok(runningSummary.contains(cancel), 'the shared action changes to Cancel inside the scroll pane');
        assert.ok(runningSummary.contains(progress), 'real in-flight progress stays inside the scroll pane');
        await waitFor(() => useViewerStore.getState().idsValidationReport !== report,
          'the shared scroll-pane action publishes a fresh real IDS report');
        const rerunReport = useViewerStore.getState().idsValidationReport;
        assert.ok(rerunReport);
        assertInvariant(rerunReport, 1);
        assert.equal(rerunReport.modelInfo[0].modelId, 'm0');
        const clear = ui.querySelector<HTMLButtonElement>('button[aria-label="Clear results"]');
        assert.ok(clear);
        click(clear);
        assert.equal(useViewerStore.getState().idsValidationReport, null);
        assert.equal(useViewerStore.getState().idsDocument, ids);
        const unload = ui.querySelector<HTMLButtonElement>('button[aria-label="Unload IDS"]');
        assert.ok(unload);
        click(unload);
        assert.equal(useViewerStore.getState().idsDocument, null);
        assert.equal(useViewerStore.getState().idsValidationReport, null);
      } else {
        click(buttonByText(ui, 'Edit rules'));
        assert.equal(useViewerStore.getState().idsValidationReport, report);
        assert.ok(ui.querySelector('input[aria-label="Rule set name"]'));
      }
      assert.equal(ui.querySelector('[data-validation-results-split]'), null);
    });
  }
}
