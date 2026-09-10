/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { AppearancePlan } from '../planner-types.js';
import { prepareAppearanceEntitySequence } from './entity-sequence.js';

async function fixture() {
  const bytes = new TextEncoder().encode(`ISO-10303-21;HEADER;FILE_DESCRIPTION(('Sequence'),'2;1');
FILE_NAME('s.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCCOLOURRGB($,1.,0.,0.);#2=IFCSURFACESTYLERENDERING(#1,0.,$,$,$,$,$,$,.NOTDEFINED.);
ENDSEC;END-ISO-10303-21;`);
  const data = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(data.properties, 'm'), editor = new StoreEditor(data, view);
  const next = view.peekNextExpressId();
  const plans: AppearancePlan[] = [0, 1].map(index => ({ sourceRevision: 'frozen', nextExpressId: next + index,
    nextAvailableExpressId: next + index + 1,
    created: [{ expressId: next + index, type: 'IfcColourRgb', attributes: [null, 0, index, 1] }],
    edits: [{ expressId: 2, index: 0, value: `#${next + index}` }], removed: index ? [next] : [], items: [], exclusions: [],
  }));
  return { view, editor, plans, next };
}

it('ordered native plans preserve repeated shared attribute edits and removed intermediates through Undo/Redo #4420', async () => {
  const f = await fixture();
  const sequence = await prepareAppearanceEntitySequence(f.editor, f.view, f.plans, 'frozen', {});
  assert.equal(f.view.getPositionalMutationsForEntity(2), null, 'preparation does not publish');
  sequence.prepared.commit();
  assert.equal(f.view.getPositionalMutationsForEntity(2)?.get(0), `#${f.next + 1}`);
  assert.equal(f.editor.getNewEntity(f.next), null);
  assert.ok(f.editor.getNewEntity(f.next + 1));
  f.view.prepareAtomic(draft => sequence.replay(draft, 'undo')).commit();
  assert.equal(f.view.getPositionalMutationsForEntity(2), null, 'first original attribute is restored, not the intermediate row');
  assert.equal(f.editor.getNewEntity(f.next), null);
  assert.equal(f.editor.getNewEntity(f.next + 1), null);
  f.view.prepareAtomic(draft => sequence.replay(draft, 'redo')).commit();
  assert.equal(f.view.getPositionalMutationsForEntity(2)?.get(0), `#${f.next + 1}`);
  assert.equal(f.editor.getNewEntity(f.next), null);
  assert.ok(f.editor.getNewEntity(f.next + 1));
  sequence.prepared.dispose();
});

it('a later invalid allocation refuses the entire sequence before publication #4420', async () => {
  const f = await fixture(); f.plans[1].nextExpressId++;
  await assert.rejects(prepareAppearanceEntitySequence(f.editor, f.view, f.plans, 'frozen', {}), /allocation or revision/);
  assert.equal(f.view.getMutations().length, 0);
  assert.equal(f.view.peekNextExpressId(), f.next);
});

it('cancellation during cooperative sequence preparation leaves no partial shared-resource edits #4420', async () => {
  const f = await fixture(), abort = new AbortController();
  await assert.rejects(prepareAppearanceEntitySequence(f.editor, f.view, f.plans, 'frozen', {
    signal: abort.signal, maxSliceMs: Number.MIN_VALUE, yieldTask: async () => { abort.abort(); },
  }), /abort/i);
  assert.equal(f.view.getMutations().length, 0);
  assert.equal(f.view.peekNextExpressId(), f.next);
});
