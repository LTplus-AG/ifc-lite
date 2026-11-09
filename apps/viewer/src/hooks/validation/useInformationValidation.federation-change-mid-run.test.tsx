/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A1 (implicit-state audit): a rule-set run must not publish for a model set
 * that changed while it ran. `run()` reads every loaded model, then awaits
 * the engine; `removeModel` mid-run cleared the report slot but left the run
 * going, so it published a report naming the removed model.
 *
 * The removal is issued synchronously right after `run()` starts, so it
 * lands before the engine's first `await` resumes — deterministic, unmocked.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { Rule, type RuleSetFile } from '@ifc-lite/rules';
import { render, cleanup } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
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

async function parseSample(): Promise<IfcDataStore> {
  const bytes = readFileSync(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
  return new IfcParser().parseColumnar(new Uint8Array(bytes).buffer);
}

async function seedTwoModels(): Promise<void> {
  const a = await parseSample();
  const b = await parseSample();
  useViewerStore.setState(fixtureModels(
    { ...fixtureModel('a'), name: 'a.ifc', ifcDataStore: a },
    { ...fixtureModel('b', { idOffset: 1_000_000 }), name: 'b.ifc', ifcDataStore: b },
  ));
  assert.ok(useViewerStore.getState().addValidationDefinition({ kind: 'rules', file: ruleSet }));
  render(<Owner />);
}

for (const [label, teardown] of [
  ['removing a federated model', () => useViewerStore.getState().removeModel('b')],
  ['a session reset ("open a new file")', () => useViewerStore.getState().resetViewerState()],
] as const) {
  it(`A1: ${label} mid-run discards the rule-set run`, async () => {
    await seedTwoModels();
    let pending: Promise<void> | undefined;
    act(() => { pending = owner.run(); });
    assert.equal(owner.running, true, 'setup: the run is in flight');
    act(() => { teardown(); });
    assert.equal(owner.running, false, 'the teardown itself ends the run');
    assert.equal(owner.progress, null);
    await act(async () => { await pending; });
    const s = useViewerStore.getState();
    assert.equal(s.idsValidationReport, null, 'no report for a model set that no longer exists');
    assert.equal(s.currentValidationReport, null);
    assert.equal(owner.running, false);
    assert.equal(owner.progress, null, 'no progress written after the run was invalidated');
    assert.deepEqual(useActivityJournal.getState().jobs.map((job) => job.outcome), ['cancelled']);
  });
}

it('A1: an untouched model set still publishes the rule-set report', async () => {
  await seedTwoModels();
  await act(async () => { await owner.run(); });
  assert.equal(useViewerStore.getState().idsValidationReport?.source.kind, 'rules');
  assert.equal(owner.running, false);
});
