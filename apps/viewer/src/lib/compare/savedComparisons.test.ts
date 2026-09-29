/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { diffModels } from '@ifc-lite/diff';
import { tableMessage } from '../document/generate-document-pdf';
import { comparisonModels, comparisonResult } from '@/test/saved-comparison-fixture';
import { snapshotComparison, isSavedComparison, comparisonSummary } from './savedComparisons';
import { loadSavedComparisons, SAVED_COMPARISONS_KEY } from './savedComparisonPersistence';
import { resolveComparisonTableState } from '../document/resolve-comparison-table';
import { flattenRawModel } from '../document/resolve-table';
import { composeDocument, estimateTextWidth } from '../document/compose';
import { DOCUMENT_VERSION, validateDocumentSpec, migrateDocumentSpec } from '../document/types';
import { parseDocumentFile } from '../document/persistence';
import { TABLE_ROW_HEIGHT } from '../document/compose-table';
import { REPORT_MARGIN } from '../export/report/compose';

afterEach(() => localStorage.removeItem(SAVED_COMPARISONS_KEY));
describe('Saved comparison invariants (#6506)', () => {
  it('snapshots the canonical diff of three distinct pairs, preserving change identities, counts and provenance', () => {
    const models = comparisonModels();
    const ab = snapshotComparison(comparisonResult('A', 'B'), models, 'A/B');
    const ac = snapshotComparison(comparisonResult('A', 'C'), models, 'A/C');
    const bc = snapshotComparison(comparisonResult('B', 'C'), models, 'B/C');
    assert.deepEqual(ab.report.rows.map((r) => [r.globalId, r.state]), [['new', 'added'], ['wall', 'modified'], ['removed', 'deleted']]);
    assert.deepEqual(ac.report.rows.map((r) => [r.globalId, r.state]), [['new', 'added'], ['third', 'added'], ['wall', 'modified'], ['removed', 'deleted']]);
    assert.deepEqual(bc.report.rows.map((r) => [r.globalId, r.state]), [['third', 'added'], ['new', 'modified']]);
    assert.equal(ac.report.counts.added, 2);
    assert.equal(bc.report.counts.deleted, 0);
    assert.ok([ab, ac, bc].every(isSavedComparison));
    assert.throws(() => snapshotComparison(comparisonResult('A', 'B'), new Map(), 'missing'), /still be loaded/);
    models.clear();
    const state = resolveComparisonTableState(ac);
    assert.ok(state.status === 'ok' && state.kind === 'comparison');
    const flat = flattenRawModel(state.model, 2, { more: (n) => `${n} more`, total: String });
    assert.equal(flat.more, 2);
    assert.equal(flat.rows.at(-1)?.cells[0], '2 more');
    assert.deepEqual(flat.rows.slice(0, 2).map((r) => r.cells[0]), ['new', 'third']);
  });

  it('captures blank model names with stable pair identities and rejects blank imported provenance', () => {
    const result = { ...comparisonResult('A', 'B'), baseName: '  ', headName: '' };
    const saved = snapshotComparison(result, comparisonModels(), '');
    assert.equal(saved.name, 'A → B');
    assert.equal(saved.report.baseModel, 'A');
    assert.equal(saved.report.headModel, 'B');
    assert.deepEqual(new Set(saved.report.rows.map((row) => row.model)), new Set(['A', 'B']));
    assert.ok(comparisonSummary(saved).includes('Base: A; Head: B'));
    assert.ok(isSavedComparison(saved));
    for (const key of ['baseModel', 'headModel'] as const) {
      const invalid = { ...saved, report: { ...saved.report, [key]: '  ' } };
      assert.equal(isSavedComparison(invalid), false);
      const document = { version: DOCUMENT_VERSION, id: 'scope', name: 'Scope', page: { size: 'A4', orientation: 'portrait' }, blocks: [{ kind: 'table', id: 'table', source: { kind: 'comparison', comparison: invalid } }] };
      assert.ok(validateDocumentSpec(document).length > 0);
    }
    const named = snapshotComparison({ ...result, baseName: '  exact authored name  ' }, comparisonModels(), 'Named');
    assert.equal(named.report.baseModel, '  exact authored name  ', 'nonblank authored names retain their exact evidence');
  });

  it('retains a completed no-change pair and reports it explicitly without loaded models', () => {
    const result = comparisonResult('A', 'B');
    const base = result.diff.entries.flatMap((e) => e.base ? [e.base] : []);
    const head = base.map((fp) => ({ ...fp, ref: { ...fp.ref, modelId: 'B' } }));
    result.diff = diffModels(base, head, { scope: 'data' });
    const saved = snapshotComparison(result, comparisonModels(), 'No change');
    assert.equal(saved.report.rows.length, 0);
    assert.equal(saved.report.counts.modified, 0);
    assert.ok(isSavedComparison(saved));
    assert.equal(tableMessage(resolveComparisonTableState(saved)), 'No changes in this saved comparison.');
    assert.ok(comparisonSummary(saved).includes('Products: Added 0; deleted 0; modified 0'));
  });

  it('rejects malformed stored/embedded reports while retaining other valid pairs and migrates v1–8 documents', () => {
    const valid = snapshotComparison(comparisonResult('A', 'B'), comparisonModels(), 'pair');
    const corrupt = { ...valid, id: 'corrupt', report: { ...valid.report, rows: [{ ...valid.report.rows[0], movedDistance: 'far' }] } };
    const invalidMatch = { ...valid, id: 'bad-match', report: { ...valid.report, rows: [{ ...valid.report.rows[0], match: { toString: null } }] } };
    localStorage.setItem(SAVED_COMPARISONS_KEY, JSON.stringify([valid, corrupt, invalidMatch, valid]));
    assert.equal(loadSavedComparisons().length, 1, 'invalid entries and duplicate ids never shadow valid history');
    const doc = { version: DOCUMENT_VERSION, id: 'doc', name: 'Report', page: { size: 'A4', orientation: 'portrait' }, blocks: [{ kind: 'table', id: 't', source: { kind: 'comparison', comparison: valid } }] };
    assert.deepEqual(validateDocumentSpec(doc), []);
    for (let version = 1; version <= 8; version++) assert.deepEqual(validateDocumentSpec(migrateDocumentSpec({ ...doc, version, blocks: [] })), []);
    const version8 = parseDocumentFile(JSON.stringify({ ...doc, version: 8, blocks: [
      { kind: 'text', id: 'before', text: 'Before', style: 'body' },
      { kind: 'page-break', id: 'break' }, { kind: 'text', id: 'after', text: 'After', style: 'body' },
    ] }));
    assert.equal(version8.version, DOCUMENT_VERSION);
    assert.deepEqual(version8.blocks.map((block) => block.kind), ['text', 'page-break', 'text'], 'format8 page-break semantics survive comparison-source migration');
    assert.throws(() => parseDocumentFile(JSON.stringify({ ...doc, blocks: [{ ...doc.blocks[0], source: { kind: 'comparison', comparison: corrupt } }] })), /source.comparison/);
    const copy = parseDocumentFile(JSON.stringify(doc));
    assert.equal(copy.blocks[0].kind, 'table');
    if (copy.blocks[0].kind !== 'table' || copy.blocks[0].source.kind !== 'comparison') throw new Error('expected comparison');
    assert.deepEqual(copy.blocks[0].source.comparison.report.rows, valid.report.rows);
  });

  it('keeps complete multi-page comparison provenance with its first table row at the boundary', () => {
    const saved = snapshotComparison(comparisonResult('A', 'B'), comparisonModels(), 'Report');
    const names = Array.from({ length: 160 }, (_, i) => `model-${String(i).padStart(3, '0')}-long-authoring-source.ifc`);
    saved.report.baseModel = names.join('; ');
    const state = resolveComparisonTableState(saved);
    assert.ok(state.status === 'ok' && state.kind === 'comparison');
    const summary = comparisonSummary(saved);
    const layout = composeDocument({ name: saved.name, page: { size: 'A4', orientation: 'portrait' }, generatedAt: '', measure: estimateTextWidth,
      blocks: [{ kind: 'spacer', id: 'preceding-space', height: 600 },
        { kind: 'table', id: 'saved', title: saved.name, summary, columns: state.model.columns, rows: state.model.rows }],
    });
    assert.ok(layout.pages.length >= 3, 'the complete provenance spans pages after the preceding content');
    const text = layout.pages.flatMap((page) => page.items.flatMap((item) => item.kind === 'text' ? [item.text] : [])).join(' ');
    for (const name of names) assert.ok(text.includes(name), `${name} is retained without ellipsis`);
    const finalLine = summary.at(-1)!;
    const finalProvenancePage = layout.pages.find((page) => page.items.some((item) => item.kind === 'text' && item.text === finalLine));
    assert.ok(finalProvenancePage);
    assert.ok(finalProvenancePage.items.some((item) => item.kind === 'table' && item.rows[0]?.cells[0] === 'new'),
      'the last provenance line is never orphaned from the first table row');
    for (const page of layout.pages) for (const item of page.items) {
      assert.ok(item.y >= REPORT_MARGIN + 30 && item.y <= layout.size.h - REPORT_MARGIN - 24);
      if (item.kind === 'table') assert.ok(item.y + (item.rows.length + 1) * TABLE_ROW_HEIGHT <= layout.size.h - REPORT_MARGIN - 24 + 0.01);
    }
  });

  it('wraps long provenance/caveats and paginates all saved rows inside page bounds', () => {
    const saved = snapshotComparison(comparisonResult('A', 'C'), comparisonModels(), 'Report');
    saved.report.baseModel = 'A very long authoring model name '.repeat(25);
    saved.geometryUnavailable = true;
    saved.report.rows = Array.from({ length: 200 }, (_, i) => ({ ...saved.report.rows[0], globalId: `row-${i}` }));
    const state = resolveComparisonTableState(saved);
    assert.ok(state.status === 'ok' && state.kind === 'comparison');
    const layout = composeDocument({ name: saved.name, page: { size: 'A4', orientation: 'portrait' }, generatedAt: '', measure: estimateTextWidth,
      blocks: [{ kind: 'table', id: 'saved', title: saved.name, summary: comparisonSummary(saved), columns: state.model.columns, rows: state.model.rows }],
    });
    const rows = layout.pages.flatMap((page) => page.items.flatMap((item) => item.kind === 'table' ? item.rows : []));
    assert.equal(rows.length, 200);
    assert.equal(rows.at(-1)?.cells[0], 'row-199');
    assert.ok(layout.pages.flatMap((p) => p.items).some((i) => i.kind === 'text' && i.text.includes('Geometry unavailable')));
    for (const page of layout.pages) for (const item of page.items) {
      assert.ok(item.y >= REPORT_MARGIN + 30);
      assert.ok(item.kind !== 'table' || item.y + (item.rows.length + 1) * TABLE_ROW_HEIGHT <= layout.size.h - REPORT_MARGIN - 24 + 0.01);
      if (item.kind === 'text') assert.ok(estimateTextWidth(item.text, item.size, item.bold) <= layout.size.w - REPORT_MARGIN * 2 + 0.01);
    }
  });
});
