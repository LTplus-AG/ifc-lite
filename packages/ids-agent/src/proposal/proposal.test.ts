/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { apply, createStudioState, undo, type StudioOp } from '@ifc-lite/ids-authoring';
import { describe, expect, it } from 'vitest';
import { scriptedTransport, toolCall, turn } from '../testing/index.js';
import { doorDoc, doorOps, emptyDoc, id, schemaContexts } from '../../test/helpers.js';
import { runAgent } from '../runner/loop.js';
import { acceptProposal } from './proposal.js';
import { initialSelection, proposalView, setSpecSelected, toggleBatch } from './view-model.js';

async function twoSpecRun(doc = emptyDoc()) {
  const { gate, lint } = await schemaContexts();
  const { transport } = scriptedTransport([
    turn([toolCall('ids_apply_ops', { ops: doorOps('Pset_DoorCommon', 'FireRating', '@doors'), rationale: 'Door fire rating', sources: [{ quote: 'Doors: fire rating.' }] })]),
    turn([toolCall('ids_apply_ops', { ops: doorOps('Pset_DoorCommon', 'IsExternal', '@ext'), rationale: 'External flag' })]),
    turn([toolCall('ids_mark_unresolved', { statement: 'Door widths fit the escape route.', category: 'geometry', reason: 'Geometry.' })]),
    turn([{ type: 'text', text: 'Two specifications.' }]),
  ]);
  return { run: await runAgent({ transport, mode: 'draft', request: 'r', doc, gate, lint }), gate };
}

describe('acceptProposal', () => {
  it('commits the chosen batches as one history entry attributed to the run', async () => {
    const { run, gate } = await twoSpecRun();
    const live = createStudioState(emptyDoc());
    const result = acceptProposal(live, run.proposal, { gate });
    expect(result.accepted).toEqual(['b1', 'b2']);
    expect(result.state.doc.ids.specifications).toHaveLength(2);
    expect(result.state.history.past).toHaveLength(1);
    expect(result.state.history.past[0].source).toEqual({ by: 'ai', runId: run.runId, model: run.proposal.model });
    expect(undo(result.state).doc.ids.specifications).toHaveLength(0);
  });

  it('accepts a subset and leaves the live state alone when nothing is accepted', async () => {
    const { run, gate } = await twoSpecRun();
    const live = createStudioState(emptyDoc());
    const result = acceptProposal(live, run.proposal, { gate, batchIds: ['b2'] });
    expect(result.state.doc.ids.specifications.map((s) => s.name)).toEqual(['Door fire rating']);
    expect(acceptProposal(live, run.proposal, { gate, batchIds: [] }).state).toBe(live);
  });

  it('re-gates every batch against the live document, which may have changed since the run', async () => {
    const { doc, specId } = doorDoc();
    const { gate, lint } = await schemaContexts();
    const { transport } = scriptedTransport([
      turn([toolCall('ids_apply_ops', { ops: [{ kind: 'spec.set', payload: { specId, field: 'description', value: 'All doors' } }] })]),
      turn([{ type: 'text', text: 'ok' }]),
    ]);
    const run = await runAgent({ transport, mode: 'edit', request: 'describe', doc, gate, lint });
    // Meanwhile the user deleted the specification.
    const removed: StudioOp = { kind: 'spec.remove', opId: id(), payload: { specId } };
    const live = createStudioState(apply(doc, [removed]).doc);
    const result = acceptProposal(live, run.proposal, { gate });
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]).toMatchObject({ batchId: 'b1', refusals: [{ code: expect.stringMatching(/^GATE-STR/) }] });
    expect(result.state).toBe(live);
  });
});

describe('proposal view model', () => {
  it('groups batches by specification with sources, unresolved statements and counts', async () => {
    const { run } = await twoSpecRun();
    const selection = initialSelection(run.proposal);
    const view = proposalView(run.proposal, selection);
    expect(view.specs.map((s) => [s.name, s.change, s.selected])).toEqual([['Door fire rating', 'added', 'all'], ['Door fire rating', 'added', 'all']]);
    expect(view.specs[0].batches[0]).toMatchObject({ id: 'b1', label: 'Door fire rating', opCount: 3, opKinds: ['spec.add', 'facet.add'], sources: [{ quote: 'Doors: fire rating.' }] });
    expect(view.unresolved).toMatchObject([{ category: 'geometry' }]);
    expect(view.counts).toMatchObject({ batches: 2, selected: 2, ops: 6, selectedOps: 6 });
    expect(view.stoppedBecause).toBeUndefined();
    expect(view.tokens).toEqual({ input: 400, output: 200, complete: true });
  });

  it('toggles a batch and a whole specification', async () => {
    const { run } = await twoSpecRun();
    let selection = toggleBatch(initialSelection(run.proposal), 'b1');
    let view = proposalView(run.proposal, selection);
    expect(view.specs[0].selected).toBe('none');
    expect(view.counts.selected).toBe(1);
    selection = setSpecSelected(run.proposal, selection, view.specs[0].specId, true);
    view = proposalView(run.proposal, selection);
    expect(view.specs[0].selected).toBe('all');
    selection = toggleBatch(selection, 'b1');
    expect(selection.has('b1')).toBe(false);
  });

  it('marks changed and removed specifications against the base and explains an early stop', async () => {
    const { doc, specId } = doorDoc();
    const { gate, lint } = await schemaContexts();
    const { transport } = scriptedTransport([
      turn([toolCall('ids_apply_ops', { ops: [{ kind: 'spec.set', payload: { specId, field: 'description', value: 'd' } }] })]),
      turn([toolCall('ids_apply_ops', { ops: [{ kind: 'spec.remove', payload: { specId } }] })]),
    ]);
    const run = await runAgent({ transport, mode: 'edit', request: 'r', doc, gate, lint });
    const view = proposalView(run.proposal, initialSelection(run.proposal));
    expect(view.status).toBe('error');
    expect(view.stoppedBecause).toBeDefined();
    expect(view.specs[0]).toMatchObject({ name: 'Doors', change: 'removed', selected: 'all' });
  });
});
