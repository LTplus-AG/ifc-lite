/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export dialogs that run outside `ExportDialogShell` still appear in the
 * activity tray (U02, #6925; PR #6952 review): the clash BCF archive, the IDS
 * BCF report and the Charts PDF report. Each records running, then completed,
 * or failed with the real error, through the dialog's own production runner.
 * A failure is forced at the browser's download step (`URL.createObjectURL`).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { Clash, ClashResult } from '@ifc-lite/clash';
import type { ValidationReport } from '@ifc-lite/ids';
import type { DashboardSpec } from '@ifc-lite/charts';
import { useViewerStore } from '@/store';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import { useActivityJournal, type ActivityJob } from '@/lib/activity/activity-journal';
import { useValidationExports, type ValidationExportsApi } from '@/hooks/validation/useValidationExports';
import { ClashBcfExportDialog } from './ClashBcfExportDialog.js';
import { ReportExportDialog } from './charts/ReportExportDialog.js';

const initial = useViewerStore.getState();
const createObjectURL = URL.createObjectURL;
const consoleError = console.error;

beforeEach(() => { console.error = () => {}; }); // the dialogs log the forced failures
afterEach(() => {
  cleanup();
  URL.createObjectURL = createObjectURL;
  console.error = consoleError;
  sessionStorage.clear();
  useActivityJournal.setState({ jobs: [] });
  useViewerStore.setState(initial, true);
});

const jobs = (): ActivityJob[] => useActivityJournal.getState().jobs;
function failDownloads(): void {
  URL.createObjectURL = () => { throw new Error('Download blocked'); };
}
const button = (label: RegExp) => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
  .find((candidate) => label.test(candidate.textContent ?? ''));

function clash(id: string): Clash {
  return {
    id, rule: 'hard-clash', status: 'hard', distance: -0.05, point: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    a: { key: `${id}-a`, ref: 1, model: 'm', tag: 'IfcWall' }, b: { key: `${id}-b`, ref: 2, model: 'm', tag: 'IfcColumn' }, severity: 'major',
  };
}

const CLASHES: ClashResult = {
  clashes: [clash('c1'), clash('c2')],
  summary: { total: 2, byRule: { 'hard-clash': 2 }, byTypePair: {}, bySeverity: { critical: 0, major: 2, minor: 0, info: 0 } },
  rulesRun: [{ id: 'hard-clash', name: 'Hard', a: 'IfcWall', b: 'IfcColumn', mode: 'hard' }],
  settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
};

async function exportClashBcf(): Promise<void> {
  useViewerStore.setState({ clashResult: CLASHES });
  render(<ClashBcfExportDialog open onOpenChange={() => {}} scope="all" onScopeChange={() => {}} scopeIds={{ selected: new Set(), filtered: new Set() }} />);
  await act(async () => { button(/^Export \d+ topics?$/)!.click(); });
  await waitFor(() => jobs().length === 1 && jobs()[0].outcome !== 'running', 'the export finished');
}

describe('clash BCF export in the activity tray', () => {
  it('records a completed export under the dialog name', async () => {
    await exportClashBcf();
    assert.deepEqual([jobs()[0].kind, jobs()[0].subject, jobs()[0].outcome], ['export', 'Export to BCF', 'completed']);
  });

  it('records a failed export with the real error', async () => {
    failDownloads();
    await exportClashBcf();
    assert.deepEqual([jobs()[0].outcome, jobs()[0].detail], ['failed', 'Download blocked']);
  });
});

const REPORT: ValidationReport = {
  source: { kind: 'rules', ruleSet: { name: 'Door rules' } },
  modelInfo: [], timestamp: new Date(0), specificationResults: [],
  summary: { totalSpecifications: 0, passedSpecifications: 0, failedSpecifications: 0, totalEntitiesChecked: 0, totalEntitiesPassed: 0, totalEntitiesFailed: 0, overallPassRate: 100 },
} as unknown as ValidationReport;

describe('IDS BCF export in the activity tray', () => {
  async function exportIdsBcf(): Promise<void> {
    let api!: ValidationExportsApi;
    function Harness() { api = useValidationExports(REPORT, 'en'); return null; }
    render(<Harness />);
    await act(async () => {
      await api.exportReportBCF({ topicGrouping: 'per-specification', includePassingEntities: false, includeCamera: false, includeSnapshots: false, loadIntoBcfPanel: false });
    });
  }

  it('records a completed export', async () => {
    await exportIdsBcf();
    assert.deepEqual([jobs()[0].subject, jobs()[0].outcome], ['Export IDS Report as BCF', 'completed']);
  });

  it('records the failure the hook otherwise only shows as the panel error', async () => {
    failDownloads();
    await exportIdsBcf();
    assert.equal(useViewerStore.getState().idsError, 'Download blocked', 'the panel still reports it');
    assert.deepEqual([jobs()[0].outcome, jobs()[0].detail], ['failed', 'Download blocked']);
  });
});

describe('Charts PDF report export in the activity tray', () => {
  it('records a failed report export with the real error', async () => {
    const dashboard: DashboardSpec = {
      version: 2, id: 'd', name: 'Overview', scope: { kind: 'all' },
      charts: [{ id: 'c', title: 'Elements', source: 'elements', type: 'elementCount', measure: { agg: 'count' } }],
      layout: [{ chartId: 'c', x: 0, y: 0, w: 6, h: 4 }],
    };
    render(<ReportExportDialog dashboard={dashboard} aggregations={new Map()} onSaveReportSetup={() => {}}
      seams={async () => { throw new Error('PDF library unavailable'); }} />);
    click(button(/^Report$/)!);
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-report-export]')!.click(); });
    await waitFor(() => jobs()[0]?.outcome === 'failed', 'the export failed');
    assert.deepEqual([jobs()[0].subject, jobs()[0].detail], ['Export report', 'PDF library unavailable']);
  });
});
