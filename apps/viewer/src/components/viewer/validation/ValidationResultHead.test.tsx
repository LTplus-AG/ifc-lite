/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Source and coverage of a validation report on the shared ResultView
 * (U02, #6925). Invariant: a specification that applied to nothing is never
 * counted as applied (it would read as a pass), and one the engine could not
 * evaluate makes the run partial.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SpecificationResult, ValidationReport } from '@ifc-lite/ids';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { cleanup, render } from '@/test/render.js';
import { ValidationResultCoverage, ValidationResultSource } from './ValidationResultHead';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

const text = (root: ParentNode) => root.textContent?.replace(/\s+/g, ' ') ?? '';

function spec(name: string, applicableCount: number, extra: Partial<SpecificationResult> = {}): SpecificationResult {
  return {
    specification: { id: name, name },
    status: applicableCount === 0 ? 'not_applicable' : 'pass',
    applicableCount, passedCount: applicableCount, failedCount: 0, passRate: 100, entityResults: [], ...extra,
  };
}

function report(specs: SpecificationResult[]): ValidationReport {
  return {
    source: { kind: 'rules', ruleSet: { name: 'Door rules' } },
    modelInfo: [{ modelId: 'arc', schemaVersion: 'IFC4', entityCount: 10 }, { modelId: 'str', schemaVersion: 'IFC4', entityCount: 5 }],
    timestamp: new Date(0),
    summary: {
      totalSpecifications: specs.length, passedSpecifications: specs.length, failedSpecifications: 0,
      totalEntitiesChecked: 1234, totalEntitiesPassed: 1234, totalEntitiesFailed: 0, overallPassRate: 100,
    },
    specificationResults: specs,
  };
}

describe('validation result head (U02, #6925)', () => {
  it('names the check, every validated model and the population', () => {
    useViewerStore.setState({ ...fixtureModels(fixtureModel('arc'), fixtureModel('str')) });
    const ui = render(<ValidationResultSource report={report([])} />);
    assert.match(text(ui), /Door rules.*Models \(2\): .*1,234 entity–specification results/);
  });

  it('a specification that applied to nothing is called out, not counted as applied', () => {
    const ui = render(<ValidationResultCoverage report={report([spec('Doors', 3), spec('Windows', 0)])} />);
    assert.match(text(ui), /Complete.*1 of 2 specifications applied to elements/);
    assert.match(text(ui.querySelector('ul[aria-label="Incomplete"]')!), /1 specification had no applicable elements/);
  });

  it('an unevaluable or capped specification makes the run partial', () => {
    const unevaluable = render(<ValidationResultCoverage report={report([spec('Doors', 3), spec('Names', 4, { status: 'fail', error: 'pattern rejected' })])} />);
    assert.match(text(unevaluable), /Partial.*1 of 2 specifications applied.*1 specification could not be evaluated/);
    cleanup();
    const capped = render(<ValidationResultCoverage report={report([spec('Unique tags', 3, { setResultsTruncated: true })])} />);
    assert.match(text(capped), /Partial.*1 specification stopped its set checks at the limit/);
  });
});
