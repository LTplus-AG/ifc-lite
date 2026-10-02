/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportDocument, validateReportDocumentTemplate, type DocumentReportResult } from './build-report-document';
import { newSavedReport, savedReportBlock, validateSavedReport } from '../validation/reports/history';
import type { AutomationReportProvenance } from '../flow/report-provenance';
import { parseDocumentFile } from './persistence';
import { DOCUMENT_VERSION, validateDocumentSpec, type DocumentSpec, type IdsReportBlock } from './types';
import { prepareDocument } from './prepare-document';
import { useViewerStore } from '@/store';
import { resolveBlocks } from './generate-document-pdf';
import { coverSheetDocument } from './presets';

const snapshot = (sourceName: string): IdsReportBlock => ({
  kind: 'ids-report', id: sourceName, sourceKind: 'ids', sourceName, generatedAt: '2026-01-01T00:00:00.000Z',
  summary: { checked: 3, passed: 2, failed: 1, passRate: 66 }, checks: [],
});
const results = (): DocumentReportResult[] => [
  { jobId: 'ids', resultId: 'a', kind: 'validation', snapshot: snapshot('Model A') },
  { jobId: 'ids', resultId: 'b', kind: 'validation', snapshot: snapshot('Model B') },
  { jobId: 'rules', resultId: 'c', kind: 'validation', snapshot: { ...snapshot('Quality'), sourceKind: 'rules' } },
];
const template = (): DocumentSpec => ({ version: DOCUMENT_VERSION, id: 'template', name: 'Coordination',
  page: { size: 'A3', orientation: 'landscape' }, pageHeading: { text: 'Issued checks' },
  blocks: [{ kind: 'text', id: 'cover', text: 'Evidence', style: 'title' },
    { ...snapshot('Old run'), id: 'mapped', variant: 'long', benchmarks: false, title: 'Check detail' }],
});

describe('report document preparation (#6612)', () => {
  it('prints captured evidence names literally without evaluating their braces (#6612)', async () => {
    const document = buildReportDocument({ name: '{Today}', results: results(), context: {
      workflowName: 'Check {Model.Name}', runId: 'run', startedAt: '2026-02-02T08:00:00Z',
      models: [{ name: 'nested{part{Today}}.ifc' }],
    } });
    const imported = parseDocumentFile(JSON.stringify(document));
    const input = await prepareDocument(imported, { ...useViewerStore.getState(), models: new Map(), activeModelId: null });
    const diagnostics = { unresolved: [], missingTopics: [], tableFailures: [] };
    const resolved = await resolveBlocks(input, async () => ({ w: 1, h: 1 }), diagnostics);
    const text = resolved.flatMap((block) => block.kind === 'text' ? [block.text] : []).join('\n');
    assert.match(text, /^\{Today\}/);
    assert.ok(text.includes('Workflow: Check {Model.Name}'));
    assert.ok(text.includes('nested{part{Today}}.ifc'));
    assert.deepEqual(diagnostics.unresolved, []);
  });
  it('rejects unrelated live IDS and comparison charts before template execution (#6612)', () => {
    const chart = coverSheetDocument().blocks.find((block) => block.kind === 'chart');
    assert.ok(chart?.kind === 'chart');
    for (const source of ['ids', 'compare'] as const) {
      const document = template();
      document.blocks.push({ ...chart, id: 'live-chart', chart: { ...chart.chart, source } });
      const mappings = [{ blockId: 'mapped', jobId: 'ids' }];
      assert.match(validateReportDocumentTemplate(document, mappings, [{ jobId: 'ids', kind: 'validation' }]).join('; '), /Live .* chart live-chart/);
      assert.throws(() => buildReportDocument({ template: document, results: results(), mappings }), /Live .* chart live-chart/);
    }
  });
  it('orders independent native snapshots and survives later report mutation', () => {
    const source = results();
    const document = buildReportDocument({ results: source });
    assert.deepEqual(document.blocks.flatMap((block) => block.kind === 'ids-report' ? [block.sourceName] : []), ['Model A', 'Model B', 'Quality']);
    const first = source[0];
    if (first.kind === 'validation') first.snapshot.summary.passed = 0;
    const block = document.blocks.find((block) => block.kind === 'ids-report');
    assert.equal(block?.kind === 'ids-report' && block.summary.passed, 2);
    assert.equal(new Set(document.blocks.map((block) => block.id)).size, document.blocks.length);
    assert.deepEqual(validateDocumentSpec(document), []);
  });
  it('expands multi-model IDS mappings preserving authored presentation and original template', () => {
    const source = template();
    const document = buildReportDocument({ template: source, results: results(), mappings: [{ blockId: 'mapped', jobId: 'ids' }] });
    assert.equal(document.blocks.length, 3);
    for (const block of document.blocks.slice(1)) {
      assert.equal(block.kind, 'ids-report');
      if (block.kind === 'ids-report') {
        assert.equal(block.variant, 'long'); assert.equal(block.benchmarks, false); assert.equal(block.title, 'Check detail');
      }
    }
    assert.equal(source.blocks.length, 2);
    assert.equal(source.blocks[1].id, 'mapped');
    assert.notEqual(document.id, source.id);
    assert.deepEqual(document.page, source.page);
  });
  it('builds from a template saved at the previous format version and keeps the block size its author chose (#6548)', () => {
    const saved = { ...template(), version: DOCUMENT_VERSION - 1 } as unknown as DocumentSpec;
    saved.blocks[1] = { ...saved.blocks[1], scale: 1.5 } as DocumentSpec['blocks'][number];
    assert.deepEqual(validateReportDocumentTemplate(saved, [{ blockId: 'mapped', jobId: 'ids' }], [{ jobId: 'ids', kind: 'validation' }]), []);
    const document = buildReportDocument({ template: saved, results: results(), mappings: [{ blockId: 'mapped', jobId: 'ids' }] });
    assert.equal(document.version, DOCUMENT_VERSION, 'the built document is saved at the current version');
    assert.deepEqual(document.blocks.slice(1).map((block) => block.kind === 'ids-report' && block.scale), [1.5, 1.5]);
    assert.deepEqual(validateDocumentSpec(document), []);
  });
  it('carries the stamp choice into workflow-built reports of both source kinds (#6678)', () => {
    const stampOf = (document: DocumentSpec) => document.blocks.flatMap((block) => (block.kind === 'ids-report' ? [[block.sourceKind, 'showStamp' in block ? block.showStamp : 'absent']] : []));
    const hiddenTemplate = template();
    hiddenTemplate.blocks[1] = { ...hiddenTemplate.blocks[1], showStamp: false } as DocumentSpec['blocks'][number];
    const mapped = buildReportDocument({ template: hiddenTemplate, results: results(), mappings: [{ blockId: 'mapped', jobId: 'ids' }] });
    assert.deepEqual(stampOf(mapped), [['ids', false], ['ids', false]], 'the template block\'s choice reaches every expanded IDS block');
    const rulesTemplate = template();
    rulesTemplate.blocks[1] = { ...rulesTemplate.blocks[1], sourceKind: 'rules', showStamp: false } as DocumentSpec['blocks'][number];
    const rules = buildReportDocument({ template: rulesTemplate, results: results(), mappings: [{ blockId: 'mapped', jobId: 'rules' }] });
    assert.deepEqual(stampOf(rules), [['rules', false]], 'and to the information-validation block');
    const frozenHidden: DocumentReportResult[] = [{ jobId: 'ids', resultId: 'a', kind: 'validation', snapshot: { ...snapshot('Model A'), showStamp: false } }];
    assert.deepEqual(stampOf(buildReportDocument({ results: frozenHidden })), [['ids', false]], 'a snapshot saved with the stamp hidden stays hidden without a template');
    assert.deepEqual(stampOf(buildReportDocument({ template: template(), results: results(), mappings: [{ blockId: 'mapped', jobId: 'ids' }] })), [['ids', 'absent'], ['ids', 'absent']], 'no choice anywhere stays absent: the stamp prints');
    assert.deepEqual(validateDocumentSpec(mapped), []);
  });
  it('rejects unmapped evidence, unknown results and incompatible block mappings before export', () => {
    assert.throws(() => buildReportDocument({ template: template(), results: results() }), /requires a result mapping/);
    assert.throws(() => buildReportDocument({ template: template(), results: results(), mappings: [{ blockId: 'mapped', jobId: 'absent' }] }), /Unknown or disabled document job/);
    assert.throws(() => buildReportDocument({ template: template(), results: results(), mappings: [{ blockId: 'cover', jobId: 'ids' }] }), /requires a validation report block/);
  });
  it('prepares historical evidence without a model, exposing native content to PDF composition', async () => {
    const document = buildReportDocument({ results: results() });
    const input = await prepareDocument(document, { ...useViewerStore.getState(), models: new Map(), activeModelId: null });
    const resolved = await resolveBlocks(input, async () => ({ w: 1, h: 1 }), { unresolved: [], missingTopics: [], tableFailures: [] });
    assert.deepEqual(resolved.map((block) => block.kind), ['text', 'text', 'ids-report', 'ids-report', 'ids-report']);
    assert.equal(resolved[2].kind === 'ids-report' && resolved[2].summary.failed, 1);
  });
  it('prints a native cover with scoped run and immutable model provenance before evidence', async () => {
    const document = buildReportDocument({ name: 'Coordination result', results: results(), context: {
      workflowName: 'Morning checks', runId: 'run-123', startedAt: '2026-02-02T08:00:00.000Z',
      models: [{ name: 'Revit model.ifc', sourceFingerprint: 'sha256:abc', mutationRevision: 4 }],
      summary: 'Quality failures remain reportable.',
    } });
    const input = await prepareDocument(document, { ...useViewerStore.getState(), models: new Map(), activeModelId: null });
    const resolved = await resolveBlocks(input, async () => ({ w: 1, h: 1 }), { unresolved: [], missingTopics: [], tableFailures: [] });
    const text = resolved.flatMap((block) => block.kind === 'text' ? [block.text] : []).join('\n');
    assert.match(text, /^Coordination result/);
    assert.match(text, /2 completed jobs; 3 validation reports; 0 comparisons/);
    assert.match(text, /Workflow: Morning checks/); assert.match(text, /Run: run-123/);
    assert.match(text, /Started: 2026-02-02T08:00:00.000Z/);
    assert.match(text, /Revit model.ifc · Content identity: sha256:abc · Edit revision: 4/);
    assert.match(text, /Quality failures remain reportable/);
    assert.equal(resolved[4].kind, 'ids-report');
  });
  it('preflights required mappings, enabled job identity, compatible types and known historical results', () => {
    const source = template();
    assert.deepEqual(validateReportDocumentTemplate(source, [{ blockId: 'mapped', jobId: 'ids' }], [{ jobId: 'ids', kind: 'validation' }]), []);
    assert.match(validateReportDocumentTemplate(source, [], [{ jobId: 'ids', kind: 'validation' }]).join('; '), /requires a result mapping/);
    assert.match(validateReportDocumentTemplate(source, [{ blockId: 'mapped', jobId: 'disabled' }], [{ jobId: 'ids', kind: 'validation' }]).join('; '), /Unknown or disabled/);
    assert.match(validateReportDocumentTemplate(source, [{ blockId: 'mapped', jobId: 'compare' }], [{ jobId: 'compare', kind: 'comparison' }]).join('; '), /comparison table block/);
    assert.match(validateReportDocumentTemplate(source, [{ blockId: 'mapped', jobId: 'ids', resultId: 'missing' }], [{ jobId: 'ids', kind: 'validation', resultIds: ['saved'] }]).join('; '), /Unknown result/);
    assert.match(validateReportDocumentTemplate(source, [{ blockId: 'missing', jobId: 'ids' }], [{ jobId: 'ids', kind: 'validation' }]).join('; '), /Unknown template block/);
    source.blocks.push({ kind: 'table', id: 'live', source: { kind: 'validation', rows: 'all', columns: ['rule'] } });
    assert.match(validateReportDocumentTemplate(source, [{ blockId: 'mapped', jobId: 'ids' }], [{ jobId: 'ids', kind: 'validation' }]).join('; '), /Live validation table/);
  });
  it('preserves validated immutable workflow evidence in custom templates and native v10 JSON (#6612)', () => {
    const automation: AutomationReportProvenance = { origin: 'flow', workflowId: 'workflow', runId: 'run', jobId: 'ids', resultId: 'result',
      timestamp: '2026-02-02T08:00:00.000Z', resource: { name: 'check.ids', fingerprint: 'sha256:resource' },
      effectiveOptions: { includePassing: true }, models: [{ name: 'Model A.ifc', sourceFingerprint: 'sha256:model', mutationRevision: 3 }],
    };
    const entry = newSavedReport(snapshot('Model A'), 'IDS result', automation);
    assert.deepEqual(entry.snapshot.automation, automation);
    assert.deepEqual(savedReportBlock(entry, 'copied').automation, automation);
    assert.equal(validateSavedReport(entry), true);
    const result: DocumentReportResult = { jobId: 'ids', resultId: 'result', kind: 'validation', snapshot: entry.snapshot as IdsReportBlock };
    const document = buildReportDocument({ template: template(), results: [result], mappings: [{ blockId: 'mapped', jobId: 'ids' }] });
    automation.models[0].name = 'Later model';
    entry.automation!.runId = 'Later run';
    const report = document.blocks.find((block) => block.kind === 'ids-report');
    assert.ok(report?.kind === 'ids-report');
    assert.equal(report.automation?.runId, 'run');
    assert.equal(report.automation?.models[0].name, 'Model A.ifc');
    assert.equal(report.generatedAt, '2026-01-01T00:00:00.000Z');
    const imported = parseDocumentFile(JSON.stringify(document));
    assert.equal(imported.version, DOCUMENT_VERSION);
    assert.deepEqual(imported.blocks.find((block) => block.kind === 'ids-report')?.automation, report.automation);
    const corrupt = { ...document, blocks: [{ ...report, automation: { ...report.automation, timestamp: 'invalid' } }] };
    assert.ok(validateDocumentSpec(corrupt).some((error) => error.path.includes('automation')));
  });
  it('does not prepare a cancelled run or export an evaluator error as quality evidence', async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(prepareDocument(buildReportDocument({ results: results() }), useViewerStore.getState(), { signal: controller.signal }), { name: 'AbortError' });
    const bad = snapshot('Error');
    bad.checks = [{ id: 'bad', shortDescription: 'Bad expression', checked: 0, passed: 0, failed: 0, passRate: 0, rules: [], error: 'Evaluator failed' }];
    assert.throws(() => buildReportDocument({ results: [{ jobId: 'bad', resultId: 'bad', kind: 'validation', snapshot: bad }] }), /execution errors/);
  });
});
