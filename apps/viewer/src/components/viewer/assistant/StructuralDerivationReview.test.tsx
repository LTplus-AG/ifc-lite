/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #9668: the palette command opens the structural review for a derived model;
// the user derives, reads the plan, acknowledges, applies, and gets a receipt.
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { extractStructuralOnDemand } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { render, click, cleanup, waitFor } from '@/test/render.js';
import { seedAuthoringSample, SAMPLE_MODEL, parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { FRAME } from '@/test/structural-frame-fixture';
import { TOOL_SURFACE_COMMANDS } from '../surface-commands-tools';
import { paletteAvailability } from '../palette-availability';
import { StructuralDerivationReview } from './StructuralDerivationReview';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

const button = (root: HTMLElement, text: RegExp) =>
  [...root.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;

test('#9668 the palette command opens the derivation review when a model is loaded', async () => {
  const command = TOOL_SURFACE_COMMANDS.find((row) => row.id === 'model:derive-structural');
  assert.ok(command, 'the palette lists the command');
  let opened = 0;
  command.run({ surface: 'palette', openStructuralDerivation: () => { opened++; } });
  assert.equal(opened, 1);
  const host = { surface: 'palette' as const, openStructuralDerivation: () => {} };
  assert.deepEqual(paletteAvailability(command, host), { status: 'disabled', reasonKey: 'commandPalette.availability.ifc' }, 'refused with no model');
  await seedAuthoringSample({ bytes: FRAME });
  assert.deepEqual(paletteAvailability(command, host), { status: 'available' });
  assert.deepEqual(paletteAvailability(command, { surface: 'palette' }), { status: 'disabled', reasonKey: 'commandPalette.availability.host' }, 'refused without the dialog host');
});

test('#9668 derive, review the plan, acknowledge and apply, through the structural review step', async () => {
  const { dataStore, view } = await seedAuthoringSample({ bytes: FRAME });
  const root = render(<StructuralDerivationReview origin="test" />);
  await waitFor(() => button(root, /Derive and review/)?.disabled === false, 'the structural write path loads');
  click(button(root, /Derive and review/)!);
  await waitFor(() => /3 curve members/.test(root.textContent ?? ''), 'the plan is shown');
  assert.match(root.textContent ?? '', /4 nodes · 1 supports, 0 guessed/);
  assert.match(root.textContent ?? '', /3 elements have no LoadBearing value/);
  const apply = () => button(root, /^Apply/);
  assert.equal(apply()?.disabled, true, 'Apply waits for the acknowledgement');
  click(root.querySelector('input[type="checkbox"]')!);
  await waitFor(() => apply()?.disabled === false, 'acknowledged');
  click(apply()!);
  await waitFor(() => !apply(), 'applied');
  assert.doesNotMatch(root.textContent ?? '', /refused|changed after/i);
  const graph = extractStructuralOnDemand(await parseIfc(editedModelBytes(dataStore, view)));
  assert.equal(graph.analysisModels.length, 1);
  assert.equal(graph.members.length, 3);
  assert.equal(useViewerStore.getState().mutationViews.get(SAMPLE_MODEL), view);
});
