/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A rule-set run publishes a stamped report (#6921): like an IDS run, the
 * report carries the model state it ran against, so a later edit makes it
 * stale everywhere freshness is checked (Compare reconciliation refuses a
 * run without a stamp, and a stale one). The report also carries the rule
 * content it ran, so an edited rule is never mistaken for the same rules.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { Rule, type RuleSetFile } from '@ifc-lite/rules';
import { render, cleanup } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { analysisStampOf, isAnalysisStale } from '@/hooks/useAnalysisStaleness';
import { captureValidationRun } from '@/lib/compare/compare-analysis-state';
import { reportRuleSetOf } from '@/lib/validation/report-rule-set';
import { useActivityJournal } from '@/lib/activity/activity-journal';
import { useInformationValidation } from './useInformationValidation';

const initial = useViewerStore.getState();
beforeEach(() => { localStorage.clear(); useActivityJournal.setState({ jobs: [] }); useViewerStore.setState(initial); });
afterEach(() => { cleanup(); useActivityJournal.setState({ jobs: [] }); useViewerStore.setState(initial); });

const ruleSet: RuleSetFile = { version: 1, name: 'Wall naming', rules: [{
  id: 'wall-name', name: 'Walls are named',
  applicability: { groups: [{ rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' }], authoredAs: 'chips' },
  requirement: { kind: 'element', block: { groups: [{ rules: [Rule.attribute('Name', 'isSet', '')], combinator: 'AND' }], authoredAs: 'chips' } },
}] };

let owner: ReturnType<typeof useInformationValidation>;
function Owner() {
  owner = useInformationValidation();
  return null;
}

it('#6921 a rule-set run publishes a report stamped with the model state it ran against', async () => {
  const bytes = readFileSync(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer);
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), name: 'building-architecture.ifc', ifcDataStore: store }),
    mutationVersion: 3, geometryContentVersion: 2 });
  assert.ok(useViewerStore.getState().addValidationDefinition({ kind: 'rules', file: ruleSet }));
  render(<Owner />);
  await act(async () => { await owner.run(); });

  const state = useViewerStore.getState();
  const report = state.idsValidationReport;
  assert.ok(report && report.source.kind === 'rules' && report.specificationResults.length === 1, 'the native rule engine published');
  const stamp = analysisStampOf(report);
  assert.deepEqual(stamp && { mutationVersion: stamp.mutationVersion, geometryContentVersion: stamp.geometryContentVersion },
    { mutationVersion: 3, geometryContentVersion: 2 });
  assert.ok(reportRuleSetOf(report)?.rules.has('wall-name'), 'the run records the rule content it checked');

  const captured = captureValidationRun(state);
  assert.ok(captured?.stamp, 'a captured rules run has a known freshness');
  const live = { mutationVersion: 3, geometryContentVersion: 2, modelPlacement: state.modelPlacement, models: state.models };
  assert.equal(isAnalysisStale(captured.stamp, live), false);
  assert.equal(isAnalysisStale(captured.stamp, { ...live, mutationVersion: 4 }), true, 'a later edit makes the run stale');
});

it('#6952 two real native rule-set runs retain their distinct input names in the tray', async () => {
  const bytes = readFileSync(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer);
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), name: 'building-architecture.ifc', ifcDataStore: store }) });
  assert.ok(useViewerStore.getState().addValidationDefinition({ kind: 'rules', file: ruleSet }));
  render(<Owner />);
  await act(async () => { await owner.run(); });
  act(() => owner.setFile({ ...ruleSet, name: 'Delivery naming review' }));
  await act(async () => { await owner.run(); });
  const jobs = useActivityJournal.getState().jobs;
  assert.deepEqual(jobs.map(job => [job.subject, job.outcome]).sort(), [['Delivery naming review', 'completed'], ['Wall naming', 'completed']]);
  assert.equal(useViewerStore.getState().idsValidationReport?.source.kind, 'rules');
});
