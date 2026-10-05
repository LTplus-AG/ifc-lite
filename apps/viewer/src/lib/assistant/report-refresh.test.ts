/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { clashDiscussion, seedClashResult, typedReport } from '@/test/ai-report-fixture';
import { aiBlockOrigin } from '../document/ai-report-types';
import { validateDocumentSpec, type DocumentSpec, type TextBlock } from '../document/types';
import { cancelAssistant } from './conversation';
import { captureEvidence } from './evidence';
import { prepareReportDraft } from './report-draft';
import { applyReportRefresh, planReportRefresh } from './report-refresh';

const initial = useViewerStore.getState();
afterEach(() => { cancelAssistant(); useViewerStore.setState(initial, true); });

const textOf = (document: DocumentSpec, slot: string) =>
  document.blocks.find((block): block is TextBlock => block.kind === 'text' && block.aiProvenance?.slot === slot);

/** Clash c<i> keeps its identity across runs; citations are renumbered by native row order. */
function savedReport(): DocumentSpec {
  clashDiscussion(typedReport('## Summary\nThree hard clashes need coordination [E1].', [
    { text: 'c0 overlaps by 20 mm.', facts: [{ citation: 'E1', field: 'distance', value: -20, unit: 'mm' }] },
    { text: 'c1 overlaps by 35 mm.', facts: [{ citation: 'E2', field: 'distance', value: -35, unit: 'mm' }] },
    { text: 'c2 overlaps by 50 mm.', facts: [{ citation: 'E3', field: 'distance', value: -0.05, unit: 'm' }] },
    { text: 'The run found three clashes.', facts: [{ citation: 'summary', field: 'total', value: 3 }] },
  ]));
  const draft = prepareReportDraft('Coordination report');
  assert.deepEqual(draft.claims.map(claim => claim.status), ['supported', 'supported', 'supported', 'supported']);
  return draft.document;
}

// #6918 invariants: facts are re-found by native row identity, changed facts are flagged in the
// document, untouched generated text is regenerated, and human text is never silently rewritten.
test('refresh flags changed and missing facts, keeps human edits and deletions, and re-finds renumbered rows', () => {
  const saved = savedReport();
  const own: TextBlock = { kind: 'text', id: 'human-note', style: 'body', text: 'Site meeting on Tuesday.' };
  const editedCaption = { ...textOf(saved, 'claim-facts:C3')!, text: 'Verified on site by the MEP lead.' };
  const editedClaim = { ...textOf(saved, 'claim:C1')!, text: 'c0 overlaps by about 2 cm.' };
  const document: DocumentSpec = { ...saved, blocks: saved.blocks
    .filter(block => !(block.kind === 'text' && block.aiProvenance?.slot === 'coverage'))
    .flatMap(block => block.id === editedCaption.id ? [editedCaption] : block.id === editedClaim.id ? [editedClaim]
      : block.kind === 'text' && block.aiProvenance?.slot === 'title' ? [block, own] : [block]) };
  // Next run: c1 resolved, c2 deepened, rows reordered, so c0 is now E2 and c2 is E1.
  seedClashResult([-0.02, -0.035, -0.06], [2, 0]);
  const plan = planReportRefresh(document, captureEvidence('clash'));
  assert.deepEqual(plan.claims.map(claim => [claim.id, claim.before, claim.after, claim.changes.map(change => change.kind).join()]), [
    ['C1', 'supported', 'supported', 'unchanged'],
    ['C2', 'supported', 'contradicted', 'missing'],
    ['C3', 'supported', 'contradicted', 'changed'],
    ['C4', 'supported', 'contradicted', 'changed'],
  ]);
  // Only the edited block whose generated text changed is a conflict; the edited claim text did not change.
  assert.deepEqual(plan.conflicts.map(conflict => conflict.slot), ['claim-facts:C3']);
  const kept = applyReportRefresh(document, plan);
  assert.deepEqual(validateDocumentSpec(kept), []);
  assert.equal(kept.aiReport?.revision, 2);
  assert.equal(textOf(kept, 'claim-facts:C3')?.text, 'Verified on site by the MEP lead.', 'human edit kept by default');
  assert.equal(aiBlockOrigin(textOf(kept, 'claim-facts:C3')!), 'human-edited', 'still recognisably edited after refresh');
  assert.equal(textOf(kept, 'claim:C1')?.text, 'c0 overlaps by about 2 cm.');
  assert.equal(textOf(kept, 'coverage'), undefined, 'a deleted generated block is not restored');
  assert.equal(kept.blocks[1].id, 'human-note', 'human blocks keep their place');
  assert.equal(textOf(kept, 'claim-facts:C1')!.text, 'Supported by captured data · Sources: E2 (cited as E1)\nE2 distance: -0.02 m (captured)');
  assert.match(textOf(kept, 'claim-facts:C2')!.text, /Contradicted by captured data · Sources: E2 \(no longer in the evidence\)/);
  assert.match(textOf(kept, 'claim-refresh:C3')!.text, /1 cited value\(s\) changed and 0 are missing/);
  assert.equal(textOf(kept, 'claim-refresh:C1'), undefined, 'unchanged claims get no refresh notice');
  const notice = kept.blocks.findIndex(block => block.kind === 'text' && block.aiProvenance?.slot === 'claim-refresh:C3');
  assert.equal(kept.blocks[notice - 1].id, editedCaption.id, 'a new notice goes after its claim');
  assert.match(textOf(kept, 'refresh-summary')!.text, /Claims re-checked: 4; with changed values: 2; with missing values: 1/);
  assert.match(textOf(kept, 'provenance')!.text, /Revision 2/);
  const replaced = applyReportRefresh(document, plan, new Set([editedCaption.id]));
  assert.match(textOf(replaced, 'claim-facts:C3')!.text, /claimed -0\.05 m, captured -0\.06 m - value differs/);
  assert.match(textOf(replaced, 'claim-facts:C3')!.text, /was -0\.05 m/);
  assert.equal(aiBlockOrigin(textOf(replaced, 'claim-facts:C3')!), 'ai-generated');
});

test('a second refresh against unchanged evidence changes nothing a person wrote and flags nothing new', () => {
  const saved = savedReport();
  const once = applyReportRefresh(saved, planReportRefresh(saved, captureEvidence('clash')));
  const plan = planReportRefresh(once, captureEvidence('clash'));
  assert.deepEqual(plan.conflicts, []);
  assert.ok(plan.claims.every(claim => claim.after === 'supported' && claim.changes.every(change => change.kind === 'unchanged')));
  const twice = applyReportRefresh(once, plan);
  assert.equal(twice.aiReport?.revision, 3);
  assert.deepEqual(twice.blocks.map(block => block.id), once.blocks.map(block => block.id), 'no block added or removed');
});

test('refresh refuses a stale plan, another source and an unavailable native result', () => {
  const saved = savedReport();
  const plan = planReportRefresh(saved, captureEvidence('clash'));
  const changed = { ...saved, name: 'Renamed meanwhile' };
  assert.throws(() => applyReportRefresh(changed, plan), /document changed since the refresh was prepared/);
  assert.throws(() => planReportRefresh(saved, captureEvidence('validation')), /drafted from clash evidence, not validation/);
  useViewerStore.setState({ clashResult: null, clashRawResult: null });
  assert.throws(() => planReportRefresh(saved, captureEvidence('clash')), /No native result is available/);
  assert.throws(() => planReportRefresh({ ...saved, aiReport: undefined }, captureEvidence('clash')), /not drafted from AI evidence/);
});
