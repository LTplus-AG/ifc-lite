/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { refuseContentWrites } from '@/test/content-fixture.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { snapshotComparison, isSavedComparison } from '../compare/savedComparisons';
import { comparisonModels, comparisonResult } from '@/test/saved-comparison-fixture';
import { newSavedReport, validateSavedReport } from '../validation/reports/history';
import { loadValidationReports, VALIDATION_REPORTS_STORAGE_KEY } from '../validation/reports/persistence';
import { loadSavedComparisons, SAVED_COMPARISONS_KEY } from '../compare/savedComparisonPersistence';
import { isAutomationReportProvenance, type AutomationReportProvenance } from './report-provenance';
import { retainValidationReport, retainComparisonReport } from './report-retention';

const automation = (): AutomationReportProvenance => ({ origin: 'flow', workflowId: 'workflow', runId: 'run', jobId: 'job', resultId: 'result',
  models: [{ name: 'Model A', sourceFingerprint: 'sha256:abc', mutationRevision: 2 }],
  timestamp: '2026-01-01T00:00:00.000Z', effectiveOptions: { scope: 'both', includePassing: true },
});
const validation = () => ({ ...newSavedReport({ kind: 'ids-report', id: 'snapshot', sourceName: 'IDS',
  generatedAt: '2026-01-01T00:00:00.000Z', summary: { checked: 3, passed: 2, failed: 1, passRate: 66 }, checks: [] }), automation: automation() });
beforeEach(() => {
  localStorage.removeItem(VALIDATION_REPORTS_STORAGE_KEY); localStorage.removeItem(SAVED_COMPARISONS_KEY);
  useViewerStore.setState({ savedValidationReports: [], savedComparisons: [] });
});
afterEach(() => {
  localStorage.removeItem(VALIDATION_REPORTS_STORAGE_KEY); localStorage.removeItem(SAVED_COMPARISONS_KEY);
});

describe('workflow evidence retention (#6612)', () => {
  it('retains one supplied validation ID per result, preserves original dates and distinguishes new runs', async () => {
    const entry = validation();
    assert.equal((await retainValidationReport(entry, useViewerStore)).status, 'saved');
    assert.equal((await retainValidationReport(structuredClone(entry), useViewerStore)).status, 'duplicate');
    assert.equal((await loadValidationReports()).length, 1);
    assert.deepEqual((await loadValidationReports())[0].automation, entry.automation);
    assert.deepEqual((await loadValidationReports())[0].snapshot.automation, entry.automation);
    assert.equal((await loadValidationReports())[0].snapshot.generatedAt, entry.snapshot.generatedAt);
    const next = { ...structuredClone(entry), id: 'next-result', automation: { ...automation(), runId: 'next-run', resultId: 'next-result' } };
    assert.equal((await retainValidationReport(next, useViewerStore)).status, 'saved');
    assert.equal((await loadValidationReports()).length, 2);
    await assert.rejects(async () => (await retainValidationReport({ ...entry, name: 'Different evidence' }, useViewerStore)), /collision/);
    assert.equal((await loadValidationReports())[0].name, entry.name);
  });
  it('saves completed native comparison evidence idempotently without changing its canonical diff', async () => {
    const entry = { ...snapshotComparison(comparisonResult('A', 'B'), comparisonModels(), 'A/B'), automation: automation() };
    assert.equal((await retainComparisonReport(entry, useViewerStore)).status, 'saved');
    assert.equal((await retainComparisonReport(structuredClone(entry), useViewerStore)).status, 'duplicate');
    const [saved] = (await loadSavedComparisons());
    assert.deepEqual(saved.report.rows.map((row) => [row.globalId, row.state]), [['new', 'added'], ['wall', 'modified'], ['removed', 'deleted']]);
    assert.deepEqual(saved.automation, entry.automation);
    await assert.rejects(async () => (await retainComparisonReport({ ...entry, name: 'Overwritten' }, useViewerStore)), /collision/);
    assert.equal((await loadSavedComparisons()).length, 1);
  });
  it('keeps evidence in memory after quota refusal and persists the same result on retry', async () => {
    const refused = refuseContentWrites();
    const entry = validation();
    try {
      const result = await retainValidationReport(entry, useViewerStore);
      assert.equal(result.status, 'memory-only'); assert.equal(result.warnings.length, 1);
      assert.equal(useViewerStore.getState().savedValidationReports[0].id, entry.id);
    } finally { refused.mock.restore(); }
    assert.equal((await retainValidationReport(entry, useViewerStore)).status, 'duplicate');
    assert.equal((await loadValidationReports()).length, 1);
  });
  it('rejects malformed provenance without rejecting older native report envelopes', () => {
    const entry = validation();
    assert.equal(validateSavedReport(entry), true);
    assert.equal(validateSavedReport({ ...entry, automation: { ...automation(), timestamp: 'invalid' } }), false);
    assert.equal(validateSavedReport({ ...entry, automation: undefined }), true);
    const compare = snapshotComparison(comparisonResult('A', 'B'), comparisonModels(), 'A/B');
    assert.equal(isSavedComparison(compare), true);
    assert.equal(isSavedComparison({ ...compare, automation: { ...automation(), models: [{ name: 'A', mutationRevision: -1 }] } }), false);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    assert.equal(isAutomationReportProvenance({ ...automation(), effectiveOptions: cyclic }), false);
  });
});
