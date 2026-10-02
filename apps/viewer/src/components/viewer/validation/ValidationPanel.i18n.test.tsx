/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ValidationPanel` chrome localization (#5138): every `validationPanel.*`
 * key. Same pseudo-locale oracle as `validation-editor.i18n.test.tsx` — mark
 * every key, render the states that show it, switch locale live, and check
 * the marked text reappears.
 *
 * `running`/`cancel` render only while a real engine run is in flight
 * (transient, async) — `RunningState` is exported from `ValidationPanel.tsx`
 * specifically so this test can mount it directly with a hand-built
 * progress value instead of racing a live run. `setResult.truncated` needs
 * thousands of duplicate groups to trigger (the cap in
 * `rule-engine-sets.ts`) and is excluded from the "every key accounted for"
 * check below — a documented gap, not an oversight.
 */
import '@/test/setup-dom.js';
import { clearContentDatabase, refuseContentWrites } from '@/test/content-fixture.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import type { SetResult, SpecificationResult, ValidationReport } from '@ifc-lite/ids';
import { cleanup, click, render } from '@/test/render.js';
import { installLayout } from '@/test/dom-layout.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { validationPanelEn } from '@/i18n/catalogues/validation-panel.en';
import { useViewerStore } from '@/store';
import { addRecentRuleSet } from '@/lib/validation/recent-rule-sets';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { ValidationPanel, RunningState } from './ValidationPanel.js';
import { IdsSummary } from './ValidationPanel.idsSummary.js';
import { resetValidationPanelFixture } from './validation-test-fixture.js';
import { emptyManualReportBlock } from '@/lib/document/manual-report';
import { SavedReportSource } from '../document/SavedReportSource.js';
import { DocumentPanel } from '../document/DocumentPanel.js';
import { SaveValidationReportButton } from './SaveValidationReportButton.js';
import { Toaster } from '@/components/ui/toast';
import { validationReportSnapshot } from '@/lib/validation/reports/history';
import { loadValidationReports } from '@/lib/validation/reports/persistence';

installLayout();

type Key = keyof typeof validationPanelEn;
const ALL_KEYS = Object.keys(validationPanelEn).filter(key => key.startsWith('validationPanel.')) as Key[];
const STATIC_KEYS = ALL_KEYS.filter((key) => {
  const value = validationPanelEn[key];
  return typeof value === 'string' && !value.includes('{');
});
// `setResult.truncated` needs thousands of duplicate groups to render
// (rule-engine-sets.ts's cap) — not reachable from a small fixture.
// `error.validationFailed` is the fallback `useInformationValidation.run()`
// uses when `runRuleSet` throws something that is not an `Error` instance —
// the real engine never does that, so a fixture cannot reach it without
// poking the hook's internals rather than exercising real behaviour.
// Both are documented gaps, not oversights.
const NOT_FIXTURE_REACHABLE: Key[] = ['validationPanel.setResult.truncated', 'validationPanel.error.validationFailed'];

const mark = (key: Key) => `⟦${key}|${String(validationPanelEn[key])}⟧`;
/** For a TEMPLATED key (`{param}` placeholders), the mark's `{param}` tokens
 *  get interpolated away in the rendered output — a full `mark(key)` string
 *  never matches post-interpolation. The key-prefixed opening is enough to
 *  prove the override rendered. */
const markPrefix = (key: Key) => `⟦${key}|`;
const PSEUDO: Catalogue = Object.fromEntries(ALL_KEYS.map((key) => [key, mark(key)])) as Catalogue;

function readableStrings(container: HTMLElement | Document): Set<string> {
  const out = new Set<string>();
  container.querySelectorAll('*').forEach((element) => {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute(attr);
      if (value) out.add(value);
    }
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
  return out;
}

function foundText(strings: Set<string>, text: string): boolean {
  if (strings.has(text)) return true;
  for (const s of strings) if (s.includes(text)) return true;
  return false;
}

/** Poll until `condition` is true — the file-open path reads through a real
 *  async `FileReader`, which a single `act()` around the `change` dispatch
 *  does not wait out. */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true');
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}

function setResults(): SetResult[] {
  return [
    {
      kind: 'aggregate', label: 'sum(Qto_SpaceBaseQuantities.NetFloorArea)', groupKey: 'Building A',
      actual: '287.4 m²', expected: '> 300', passed: false, failureReason: 'aggregate',
      members: [{ modelId: 'm1', expressId: 20 }],
    },
    {
      kind: 'duplicate', label: 'unique(Name)',
      actual: 'Level 1 (2×)', expected: 'unique', passed: false, failureReason: 'duplicate',
      members: [{ modelId: 'm1', expressId: 21 }, { modelId: 'm1', expressId: 22 }],
    },
  ];
}

/** One synthetic failing entity per remaining `FailureReasonCode` (`absent`,
 *  `mismatch`, `notNumeric`, `cardinality`, `notDate` — `duplicate` and
 *  `aggregate` come from `setResults()` above). Hand-built rather than run
 *  through the real engine: this exercises the GENERALISED report RENDERING
 *  path (`SpecificationCard`/`IDSResultRows`), which is this test's subject —
 *  the engine actually producing each code is `rule-engine.sets.test.ts`'s
 *  job (#5138 PR 3). */
function entityResultsFixture(): SpecificationResult['entityResults'] {
  const reasons: Array<[string, number]> = [
    ['absent', 30], ['mismatch', 31], ['notNumeric', 32], ['cardinality', 33], ['notDate', 34],
  ];
  return reasons.map(([failureReason, expressId]) => ({
    expressId, modelId: 'm1', entityType: 'IfcWall', passed: false,
    requirementResults: [{
      requirement: { id: `req-${expressId}`, label: 'Requirement', optionality: 'required' },
      status: 'fail', facetType: 'property', checkedDescription: 'Requirement',
      failureReason,
    }],
  }));
}

function reportFixture(): ValidationReport {
  const spec: SpecificationResult = {
    specification: { id: 'spec-1', name: 'Floor area total' },
    status: 'fail', applicableCount: 7, passedCount: 0, failedCount: 5, passRate: 0,
    entityResults: entityResultsFixture(), setResults: setResults(),
  };
  return {
    source: { kind: 'rules', ruleSet: { name: 'Fixture' } },
    modelInfo: [{ modelId: 'm1', schemaVersion: 'IFC4', entityCount: 10 }],
    timestamp: new Date(0),
    summary: {
      totalSpecifications: 1, passedSpecifications: 0, failedSpecifications: 1,
      totalEntitiesChecked: 7, totalEntitiesPassed: 0, totalEntitiesFailed: 7, overallPassRate: 0,
    },
    specificationResults: [spec],
  };
}

/** Rendering oracle: use the same stated report fixture, but exercise the
 * canonical writer's accepted, storage-refused and invalid-evidence outcomes
 * so every new Save label is actually rendered under each locale (#6568). */
async function mountSaveStates(collect: () => void): Promise<void> {
  const land = async () => {
    await act(async () => { await useViewerStore.getState().retryValidationReportsSave(); });
    await clearContentDatabase();
    localStorage.clear();
    await loadValidationReports();
    const report = reportFixture();
    const snapshot = validationReportSnapshot(report, new Map(), 'locale-report');
    act(() => {
      useViewerStore.setState({ savedValidationReports: [], idsLoading: false });
      useViewerStore.getState().setIdsValidationReport(report, snapshot);
    });
    return { report, snapshot };
  };
  const completed = await land();
  const completedHost = render(<SaveValidationReportButton report={completed.report} />);
  collect();
  const save = completedHost.querySelector('button'); assert.ok(save);
  click(save);
  await waitFor(() => Object.values(useViewerStore.getState().validationReportsStorage.items).includes('saved'));
  assert.equal((await loadValidationReports()).length, 1);
  assert.equal(save.disabled, true);
  collect();
  cleanup();

  const refused = await land();
  const refusedHost = render(<SaveValidationReportButton report={refused.report} />);
  const write = refuseContentWrites();
  try {
    const pendingSave = refusedHost.querySelector('button'); assert.ok(pendingSave);
    click(pendingSave);
    await waitFor(() => Object.values(useViewerStore.getState().validationReportsStorage.items).some(state => state !== 'saving' && state !== 'saved'));
    assert.equal(Object.values(useViewerStore.getState().validationReportsStorage.items).some(state => state !== 'saving' && state !== 'saved'), true);
    assert.equal((await loadValidationReports()).length, 0);
    collect();
  } finally { write.mock.restore(); }
  cleanup();

  const invalid = await land();
  // The real writer validates evidence rather than accepting corrupt dates.
  invalid.snapshot.generatedAt = 'not-a-date';
  const rejectedHost = render(<><SaveValidationReportButton report={invalid.report} /><Toaster /></>);
  const rejectSave = rejectedHost.querySelector('button'); assert.ok(rejectSave);
  click(rejectSave);
  assert.equal((await loadValidationReports()).length, 0);
  collect();
  for (const dismiss of rejectedHost.querySelectorAll('button[aria-label="Dismiss notification"]')) click(dismiss);
  cleanup();
}

/**
 * Mounts, in turn, every state reachable without a live engine run — the
 * empty state (with a seeded "Recent" entry), authoring (via a real
 * "Open .rules.json" pick), the standalone `RunningState` (both phases),
 * and `ValidationPanel` itself with the report fixture pre-landed in the
 * store (covers `editRules`, `results.validatedAgainst`, and every
 * `setResult.*`/`reason.*` key without a live engine run) — and returns the
 * UNION of every readable string across them.
 *
 * Each stage STARTS from a null report and is unmounted (`cleanup()`)
 * before the next mounts: landing the fixture report in the store is a
 * GLOBAL write, and `ValidationPanel`'s `effectiveSource` fallback
 * (`validationSource === 'rules'`, so a remounted panel resumes a landed
 * report — see `ValidationPanel.tsx`) means a STILL-MOUNTED empty-state
 * panel would reactively flip to the results view too, erasing the very
 * entry-card text this function exists to capture.
 */
async function mountAll(): Promise<Set<string>> {
  const found = new Set<string>();
  const collect = () => { for (const s of readableStrings(document.body)) found.add(s); };

  (await mountSaveStates(collect));

  resetValidationPanelFixture();
  addRecentRuleSet('Recent fixture', JSON.stringify({ version: 1, name: 'Recent fixture', rules: [] }));
  render(<ValidationPanel />);
  collect();
  cleanup();

  const fixtureFile = new File(
    [JSON.stringify({
      version: 1, name: 'Fixture',
      rules: [{
        id: 'r1', name: 'Rule 1',
        applicability: { groups: [{ rules: [], combinator: 'AND' }], authoredAs: 'chips' },
        requirement: { kind: 'element', block: { groups: [{ rules: [], combinator: 'AND' }], authoredAs: 'chips' } },
      }],
    })],
    'fixture.rules.json',
    { type: 'application/json' },
  );
  resetValidationPanelFixture();
  const authoringHost = render(<ValidationPanel />);
  const input = authoringHost.querySelector('input[type="file"][accept=".rules.json,.json"]');
  assert.ok(input, 'expected the "Open .rules.json" hidden file input in the empty state');
  Object.defineProperty(input, 'files', { value: [fixtureFile], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  // The file read is a real async `FileReader` — wait for the empty state's
  // file input to be replaced by the authoring view. Locale-independent
  // (unlike matching a button's text, which is marked under pseudo).
  await waitFor(() => !document.body.contains(input));
  collect();
  cleanup();

  // #6567: the shared library controls are real reachable states, including
  // a newly authored unnamed check and the original IDS download action.
  // Exercise them under both locales rather than exempting catalogue keys.
  const rulesHost = render(<ValidationPanel />);
  const newRuleSet = [...rulesHost.querySelectorAll('button')].find(button =>
    button.textContent?.includes(String(validationPanelEn['validationPanel.library.new'])));
  assert.ok(newRuleSet, 'the active imported rule set exposes New rule set');
  click(newRuleSet);
  collect();
  const copy = [...rulesHost.querySelectorAll('button')].find(button =>
    button.textContent?.includes(String(validationPanelEn['validationPanel.library.copy'])));
  assert.ok(copy);
  click(copy);
  collect();
  cleanup();

  setValidationSourceChoice('ids');
  const idsHost = render(<ValidationPanel />);
  const idsInput = idsHost.querySelector<HTMLInputElement>('input[accept=".ids,.xml"]');
  assert.ok(idsInput, 'the canonical IDS import is available in its mounted panel');
  const idsXml = readFileSync(new URL('../../../../public/samples/building-architecture.ids', import.meta.url), 'utf8');
  Object.defineProperty(idsInput, 'files', { value: [new File([idsXml], 'building-architecture.ids')], configurable: true });
  await act(async () => { idsInput.dispatchEvent(new Event('change', { bubbles: true })); });
  await waitFor(() => idsHost.querySelector('select') !== null);
  collect();
  cleanup();

  // The IDS export/import summaries (#5225), including the nothing-converted
  // headlines, which a successful fixture import would not reach.
  for (const direction of ['export', 'import'] as const) {
    render(
      <IdsSummary
        summary={{ direction, converted: 0, total: 1, refused: [{ name: 'r', reasons: ['reason'] }], notes: ['note'], dropped: ['dropped'] }}
        onDismiss={() => {}}
      />,
    );
    collect();
    cleanup();
  }

  render(<RunningState progress={{ ruleIndex: 0, phase: 'applicability', done: 1, total: 10 }} totalRules={2} onCancel={() => {}} />);
  collect();
  cleanup();
  render(<RunningState progress={{ ruleIndex: 0, phase: 'requirements', done: 5, total: 10 }} totalRules={2} onCancel={() => {}} />);
  collect();
  cleanup();

  // #6500: history labels also appear in Manual validation and Documentation.
  // Mount their real controls under both locales; they are reachable states,
  // not gaps to exempt from the catalogue's coverage contract.
  resetValidationPanelFixture();
  (await useViewerStore.getState().saveValidationReport(emptyManualReportBlock('i18n-report'), 'Saved fixture'));
  useViewerStore.setState({
    manualChecklist: { version: 1, name: 'Manual fixture', groups: [] },
    manualAnswers: {},
    documents: [],
    activeDocumentId: null,
  });
  setValidationSourceChoice('manual');
  render(<ValidationPanel />);
  collect();
  cleanup();
  render(<SavedReportSource block={emptyManualReportBlock('embedded')} onChange={() => {}} />);
  collect();
  cleanup();
  const documentHost = render(<DocumentPanel />);
  await act(async () => { await Promise.resolve(); });
  const addBlock = [...documentHost.querySelectorAll('button')].find((button) => button.title === 'Add a block to the page');
  assert.ok(addBlock, 'the Documentation add menu must be reachable');
  act(() => {
    addBlock.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    addBlock.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  collect();
  cleanup();
  useViewerStore.setState({ ...initial, idsValidationReport: null, validationSource: null });

  resetValidationPanelFixture();
  useViewerStore.setState({ idsValidationReport: reportFixture(), validationSource: 'rules' });
  const resultsHost = render(<ValidationPanel />);
  // Set-level rows live inside the card's Collapsible content — expand it so
  // `setResult.*` strings actually render (mirrors IDSResultRows.sets.test.tsx).
  const cardHeader = [...resultsHost.querySelectorAll('button')].find((b) => b.textContent?.includes('Floor area total'));
  if (cardHeader) click(cardHeader);
  // Every requirement-group / entity row disclosure is a SEPARATE nested
  // toggle (`RequirementGroupRow`'s `showFailures`, `EntityResultRow`'s
  // `showDetails`) — open every one (except the card's own trigger, already
  // opened above — Radix's `CollapsibleTrigger asChild` gives it
  // `aria-expanded` too) so the per-requirement `reason.*` text renders.
  for (const toggle of resultsHost.querySelectorAll('button[aria-expanded]')) {
    if (toggle !== cardHeader) click(toggle);
  }
  collect();
  cleanup();
  resetValidationPanelFixture();

  return found;
}

const initial = useViewerStore.getState();

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState({ ...initial, idsValidationReport: null, validationSource: null });
  setValidationSourceChoice(null);
});

describe('ValidationPanel localization (#5138)', () => {
  it('translates every static key rendered across the reachable states', async () => {
    setLocale('en');
    const english = await mountAll();

    registerLocale('validation-panel-pseudo', PSEUDO);
    setLocale('validation-panel-pseudo');
    const after = await mountAll();
    setLocale('en');

    for (const key of STATIC_KEYS) {
      if (NOT_FIXTURE_REACHABLE.includes(key)) continue;
      const text = String(validationPanelEn[key]);
      if (!foundText(english, text)) continue;
      assert.ok(foundText(after, mark(key)), `${key}: "${text}" must be translated, marked text not found`);
    }
  });

  it('accounts for every static key: rendered by the fixtures, or a documented gap', async () => {
    setLocale('en');
    const english = await mountAll();
    const unaccounted = STATIC_KEYS.filter(
      (key) => !NOT_FIXTURE_REACHABLE.includes(key) && !foundText(english, String(validationPanelEn[key])),
    );
    assert.deepEqual(unaccounted, [], 'key not rendered by the fixtures — extend them or document the gap');
  });

  it('the entry cards, header toggle, and running/results states retranslate live', async () => {
    registerLocale('validation-panel-pseudo-2', PSEUDO);
    const ui = render(<ValidationPanel onClose={() => {}} />);
    act(() => setLocale('validation-panel-pseudo-2'));
    const text = ui.textContent ?? '';
    assert.ok(text.includes(mark('validationPanel.title')), 'panel title must retranslate');
    assert.ok(text.includes(mark('validationPanel.entry.idsTitle')), 'IDS entry card must retranslate');
    assert.ok(text.includes(mark('validationPanel.entry.rulesTitle')), 'rules entry card must retranslate');
    const closeButton = ui.querySelector('button[aria-label]');
    assert.ok(closeButton, 'expected the panel header close button (rendered because onClose is provided)');

    // The empty state has no toggle yet (nothing to switch between); picking
    // a source reveals the persistent header toggle, retranslated live.
    const idsEntry = ui.querySelector('[data-testid="validation-entry-ids"]');
    assert.ok(idsEntry, 'expected the IDS validation entry card');
    click(idsEntry as Element);
    const toggleText = ui.textContent ?? '';
    assert.ok(toggleText.includes(mark('validationPanel.toggle.ids')), 'toggle.ids must retranslate');
    assert.ok(toggleText.includes(mark('validationPanel.toggle.rules')), 'toggle.rules must retranslate');

    // Retranslate the standalone running state too.
    setLocale('en');
    const running = render(<RunningState progress={{ ruleIndex: 1, phase: 'requirements', done: 5, total: 10 }} totalRules={3} onCancel={() => {}} />);
    act(() => setLocale('validation-panel-pseudo-2'));
    const runningText = running.textContent ?? '';
    assert.ok(runningText.includes(markPrefix('validationPanel.running.rule')), 'running.rule must retranslate');
    assert.ok(runningText.includes(markPrefix('validationPanel.running.requirements')), 'running.requirements must retranslate');
    assert.ok(runningText.includes(mark('validationPanel.cancel')), 'cancel must retranslate');

    // #6568: the same mounted save control retranslates both before and
    // after the real writer accepts its completion-time evidence.
    cleanup();
    setLocale('en');
    localStorage.clear();
    await loadValidationReports();
    const report = reportFixture();
    act(() => {
      useViewerStore.setState({ savedValidationReports: [], idsLoading: false });
      useViewerStore.getState().setIdsValidationReport(report, validationReportSnapshot(report, new Map(), 'live-locale'));
    });
    const saveHost = render(<SaveValidationReportButton report={report} />);
    act(() => setLocale('validation-panel-pseudo-2'));
    const save = saveHost.querySelector('button'); assert.ok(save);
    assert.equal(save.textContent, mark('validationPanel.history.saveReport'));
    click(save);
    await waitFor(() => Object.values(useViewerStore.getState().validationReportsStorage.items).includes('saved'));
  assert.equal((await loadValidationReports()).length, 1);
    assert.equal(save.textContent, mark('validationPanel.history.saved'));
    act(() => setLocale('en'));
    assert.equal(save.textContent, validationPanelEn['validationPanel.history.saved']);
  });
});
