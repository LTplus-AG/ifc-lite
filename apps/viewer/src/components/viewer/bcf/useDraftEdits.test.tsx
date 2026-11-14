/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The drafts dialog's edit lane (C-2), with each asynchronous edit held open
 * by the test: the lane belongs to the batch on screen, a second edit on the
 * same batch is refused, and a refused edit that later fails is still logged.
 */

import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { cleanup, render } from '@/test/render.js';
import { deferred, interleave } from '@/test/race.js';
import type { DraftEditResult } from '@/lib/bcf-drafts/draft-edit';
import type { DraftBatch } from '@/lib/bcf-drafts/draft-types';
import { useDraftEdits, type DraftEdits } from './useDraftEdits';

afterEach(cleanup);

/** Only the id is read back: `save` receives the batch the edit produced. */
const edited = (id: string) => ({ ok: true, batch: { id } as unknown as DraftBatch }) satisfies DraftEditResult;

function mount(initial: string) {
  const saved: string[] = [];
  let lane: DraftEdits | null = null;
  let show: ((id: string) => void) | null = null;
  function Probe() {
    const [batchId, setBatchId] = useState(initial);
    show = setBatchId;
    lane = useDraftEdits(batchId, (batch) => { saved.push(batch.id); });
    return null;
  }
  render(<Probe />);
  return {
    saved,
    lane: () => { assert.ok(lane); return lane; },
    show: (id: string) => act(() => { assert.ok(show); show(id); }),
  };
}

test('switching batch frees the editor held by the previous batch, and both edits land', async () => {
  const ui = mount('batch-a');
  const editA = deferred<DraftEditResult>();
  await act(async () => ui.lane().onEdit(editA.promise));
  assert.equal(ui.lane().busy, true, 'batch A is held while its edit computes');
  ui.show('batch-b');
  assert.equal(ui.lane().busy, false, "batch B's editor is not held by batch A's edit");
  const editB = deferred<DraftEditResult>();
  await act(async () => ui.lane().onEdit(editB.promise));
  assert.equal(ui.lane().busy, true, 'an edit on batch B starts at once');
  await act(() => interleave(() => editB.resolve(edited('batch-b')), () => editA.resolve(edited('batch-a'))));
  assert.deepEqual([...ui.saved], ['batch-b', 'batch-a'], "B's edit was not refused, and A's still lands in batch A");
  assert.equal(ui.lane().busy, false);
});

test('a second edit pressed while one is held is refused; if it then fails, that failure is logged', async () => {
  const ui = mount('batch-a');
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: unknown) => { warnings.push(String(message)); };
  try {
    const first = deferred<DraftEditResult>();
    const second = deferred<DraftEditResult>();
    await act(async () => { ui.lane().onEdit(first.promise); ui.lane().onEdit(second.promise); });
    await act(() => interleave(() => second.reject(new Error('the split would empty a topic'))));
    assert.deepEqual([...warnings], ['[BCF drafts] Refused edit failed'], 'the refused edit never lands, but its failure is not swallowed');
    await act(() => interleave(() => first.resolve(edited('batch-a'))));
    assert.deepEqual([...ui.saved], ['batch-a'], 'only the held edit landed');
  } finally {
    console.warn = warn;
  }
});
