/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { aiBlockOrigin, detachAiProvenance, type AiReportRecord } from './ai-report-types';
import { buildReportDocument } from './build-report-document';
import { copyDocumentBlock, parseDocumentFile } from './persistence';
import { DOCUMENT_VERSION, validateDocumentSpec, type DocumentSpec, type IdsReportBlock, type TextBlock } from './types';

const payload = JSON.stringify({ evidence: { summary: null, rows: [{ citation: 'E1', data: { id: 'x' } }] } });
const record: AiReportRecord = { version: 1, language: 'de', model: 'provider', conversationId: 'c', revision: 1,
  evidence: { source: 'clash', capturedAt: '2026-10-05T08:00:00.000Z', payload, totalRows: 1, includedRows: 1, projectionTruncated: false },
  citedRows: { E1: 'id=x' }, claims: [{ id: 'C1', text: 'Claim', citations: ['E1'], facts: [], status: 'unverifiable', edited: false }],
  narrative: 'Text', slots: ['narrative:0'] };
const generated: TextBlock = { kind: 'text', id: 'ai', style: 'body', text: 'Text', aiProvenance: { origin: 'ai', slot: 'narrative:0', generated: 'Text' } };
const snapshot: IdsReportBlock = { kind: 'ids-report', id: 'mapped', sourceKind: 'ids', sourceName: 'Old', generatedAt: '2026-01-01T00:00:00.000Z',
  summary: { checked: 1, passed: 1, failed: 0, passRate: 100 }, checks: [] };
const aiDocument = (): DocumentSpec => ({ version: DOCUMENT_VERSION, id: 'ai-report', name: 'AI report', page: { size: 'A4', orientation: 'portrait' },
  blocks: [generated, snapshot], aiReport: record });

// #6918: provenance says "the generator wrote this text here". A copy placed elsewhere is the copier's.
test('a duplicated block and a template-built document are not AI-owned, an imported report still is', () => {
  assert.deepEqual(validateDocumentSpec(aiDocument()), []);
  const duplicate = detachAiProvenance(copyDocumentBlock(generated));
  assert.equal(duplicate.kind === 'text' && aiBlockOrigin(duplicate), 'human');
  assert.equal(aiBlockOrigin(generated), 'ai-generated', 'the original is untouched');
  const built = buildReportDocument({ template: aiDocument(), mappings: [{ blockId: 'mapped', jobId: 'ids' }],
    results: [{ jobId: 'ids', resultId: 'a', kind: 'validation', snapshot: { ...snapshot, sourceName: 'New run' } }] });
  assert.equal(built.aiReport, undefined, 'old evidence never travels into a new run');
  assert.ok(built.blocks.every(block => block.kind !== 'text' || aiBlockOrigin(block) === 'human'));
  assert.deepEqual(validateDocumentSpec(built), []);
  const imported = parseDocumentFile(JSON.stringify(aiDocument()));
  assert.deepEqual(imported.aiReport, record, 'an imported report carries its own captured evidence');
  assert.equal(imported.blocks[0].kind === 'text' && aiBlockOrigin(imported.blocks[0]), 'ai-generated');
});

test('AI report records and provenance are validated, and an edited block is told apart', () => {
  const broken = { ...aiDocument(), aiReport: { ...record, claims: [{ ...record.claims[0], status: 'certain' }] } };
  assert.match(validateDocumentSpec(broken).map(error => error.message).join(), /valid claims/);
  const noSlot = { ...aiDocument(), blocks: [{ ...generated, aiProvenance: { origin: 'ai', slot: '', generated: 'Text' } }] };
  assert.equal(validateDocumentSpec(noSlot)[0]?.path, 'blocks[0].aiProvenance');
  assert.equal(aiBlockOrigin({ ...generated, text: 'Changed by a person' }), 'human-edited');
});
