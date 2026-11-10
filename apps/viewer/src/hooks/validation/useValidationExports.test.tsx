/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The BCF export's "Export complete!" progress clears itself after a short
 * delay. That delayed clear belongs to the run that scheduled it: a second
 * export started inside the window must keep its own progress, not lose it to
 * the first run's timer while the dialog is still busy.
 */

import '@/test/setup-dom.js';
import '@/test/download-capture.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { act } from 'react';
import type { ValidationReport } from '@ifc-lite/ids';
import { render, cleanup, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useActivityJournal } from '@/lib/activity/activity-journal';
import type { IDSBCFExportSettings } from '@/components/viewer/IDSExportDialog';
import { useValidationExports } from './useValidationExports';

const initial = useViewerStore.getState();
beforeEach(() => { useActivityJournal.setState({ jobs: [] }); useViewerStore.setState(initial); });
afterEach(() => { cleanup(); useActivityJournal.setState({ jobs: [] }); useViewerStore.setState(initial); });

function report(): ValidationReport {
  return {
    source: { kind: 'rules', ruleSet: { name: 'Naming' } },
    timestamp: new Date('2026-11-09T00:00:00Z'), modelInfo: [],
    summary: { totalSpecifications: 1, passedSpecifications: 0, failedSpecifications: 1,
      totalEntitiesChecked: 1, totalEntitiesPassed: 0, totalEntitiesFailed: 1, overallPassRate: 0 },
    specificationResults: [{
      specification: { id: 'name', name: 'Walls are named' }, status: 'fail',
      applicableCount: 1, passedCount: 0, failedCount: 1, passRate: 0,
      entityResults: [{
        modelId: 'm', expressId: 10, globalId: '2O2Fr$t4X7Zf8NOew3FL01', entityType: 'IfcWall', passed: false,
        requirementResults: [{ requirement: { id: 'n', label: 'Name', optionality: 'required' },
          status: 'fail', facetType: 'attribute', checkedDescription: 'Name must be set' }],
      }],
    }],
  };
}

// No camera and no snapshots: the export needs no renderer, so it finishes
// well inside the (shortened) completion window.
const settings: IDSBCFExportSettings = {
  topicGrouping: 'per-entity', includePassingEntities: false,
  includeCamera: false, includeSnapshots: false, loadIntoBcfPanel: false,
};

/** The production 2 s window, shortened so the test spends little real time. */
const LINGER_MS = 400;

let owner: ReturnType<typeof useValidationExports>;
function Owner({ value }: { value: ValidationReport }) {
  owner = useValidationExports(value, 'en', LINGER_MS);
  return null;
}

it('(#9487) a second BCF export inside the completion window keeps its progress past the first run\'s clear (B1)', async () => {
  const value = report();
  render(<Owner value={value} />);

  await act(async () => { await owner.exportReportBCF(settings); });
  assert.equal(owner.bcfExportProgress?.phase, 'done', 'the first run reports completion');
  const firstDoneAt = Date.now();

  // Start the second export 60% into the first run's completion window.
  await advance(LINGER_MS * 0.6);
  await act(async () => { await owner.exportReportBCF(settings); });
  assert.equal(owner.bcfExportProgress?.phase, 'done', 'the second run reports completion');
  const secondDoneAt = Date.now();

  // Past the first run's deadline, inside the second run's own window.
  await advance(Math.max(0, firstDoneAt + LINGER_MS * 1.2 - Date.now()));
  assert.ok(Date.now() < secondDoneAt + LINGER_MS, 'still inside the second run\'s window');
  assert.equal(owner.bcfExportProgress?.phase, 'done',
    'the first run\'s timer must not clear the second run\'s progress');

  // The second run's own clear still happens.
  await advance(Math.max(0, secondDoneAt + LINGER_MS * 1.3 - Date.now()));
  assert.equal(owner.bcfExportProgress, null, 'the second run clears its own completion');
});
