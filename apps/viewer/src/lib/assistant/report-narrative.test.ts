/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { TextBlock } from '../document/types';
import { appendixBlocks, narrativeBlocks } from './report-narrative';

const text = (style: TextBlock['style'], value: string): TextBlock => ({ kind: 'text', id: `b-${value.length}`, style, text: value });
const styled = (blocks: TextBlock[]) => blocks.map(block => [block.style, block.text]);

test('a typed clash proposal becomes one document section per group instead of JSON', () => {
  const answer = JSON.stringify({ version: 1, kind: 'clash.groups', groups: [
    { name: 'Rafters into slabs', explanation: 'Roof framing overlaps.', citations: ['E2', 'E3'] },
    { name: 'Railings', explanation: 'Near-zero contact.', citations: ['E11'] }] }, null, 2);
  const blocks = narrativeBlocks(answer, text);
  assert.deepEqual(styled(blocks).slice(1), [
    ['subheading', 'Rafters into slabs'], ['body', 'Roof framing overlaps.'], ['small', 'Findings (2): E2, E3'],
    ['subheading', 'Railings'], ['body', 'Near-zero contact.'], ['small', 'Findings (1): E11']]);
  assert.ok(blocks.every(block => !block.text.includes('"kind"')));
});

test('Markdown maps onto native text styles without raw markers', () => {
  const blocks = narrativeBlocks('## Where\n\nMostly **beams** [E1].\n\n- one\n- `two`\n\n| A | B |\n|---|---|\n| x | 1 |', text);
  assert.deepEqual(styled(blocks), [['subheading', 'Where'], ['body', 'Mostly beams [E1].'], ['body', '• one\n• two'], ['small', 'A  ·  B\nx  ·  1']]);
});

test('the appendix lists models, the native summary and one readable line per included row', () => {
  const payload = { models: [{ id: 'm', name: 'House.ifc', fingerprint: 'House.ifc:abc' }], totalRows: 3, includedRows: 2, sampled: true,
    evidence: { summary: { total: 3, bySeverity: { info: 3 } } } };
  const rows = [
    { citation: 'E1', data: { a: { tag: 'IfcBeam', key: 'g1' }, b: { tag: 'IfcMember', key: 'g2' }, status: 'hard', severity: 'info',
      distance: -0.0812345, distanceKind: 'estimate', disciplineCandidates: { a: ['STR'], b: [] } } },
    { citation: 'E2', data: { specification: { name: 'Walls need fire rating' }, status: 'fail', failedCount: 4 } }];
  const blocks = appendixBlocks(payload, rows, text);
  const all = blocks.map(block => block.text).join('\n');
  assert.match(all, /Models at capture: House\.ifc \(House\.ifc:abc\)\./);
  assert.match(all, /Rows: 2 of 3 included \(sample\)\./);
  assert.match(all, /^bySeverity\.info: 3$/m);
  assert.match(all, /^E1\s+IfcBeam vs IfcMember · hard · info · -0\.0812 m \(estimate\) · disciplines STR vs unknown · g1 vs g2$/m);
  assert.match(all, /^E2\s+specification\.name: Walls need fire rating · status: fail · failedCount: 4$/m);
  assert.doesNotMatch(all, /[{}]/);
});
