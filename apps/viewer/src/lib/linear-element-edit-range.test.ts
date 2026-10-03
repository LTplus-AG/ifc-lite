/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { addBeamToStore, resolveSpatialAnchor } from '@ifc-lite/create';
import { StepExporter } from '@ifc-lite/export';
// Existing viewer contracts remain loadable during the production-revert oracle.
import { resolveLinearElementChain } from './linear-element-edit.js';
import { readAttributes, resolvePlacementChain, asExpressIdRef } from './placement-core.js';

for (const persisted of [false, true]) {
  it(`#6232 refuses overflowing linear-axis magnitude without changing the ${persisted ? 'persisted STEP' : 'overlay'} graph`, async () => {
    const parser = new IfcParser();
    const bytes = new Uint8Array(await readFile(new URL('../../public/samples/hello-wall.ifc', import.meta.url)));
    let store = await parser.parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
    let view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
    const beam = addBeamToStore(editor, resolveSpatialAnchor(store, 42, view), {
      Start: [1, 2, 3], End: [5, 2, 3], Width: .2, Height: .3,
    });
    const placement = resolvePlacementChain(store, view, editor, beam.beamId);
    assert.ok(placement);
    const direction = asExpressIdRef(readAttributes(store, view, editor, placement.axisPlacementId)?.[1]);
    assert.notEqual(direction, null);
    const axisId = direction!;
    editor.setPositionalAttribute(axisId, 0, [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE]);
    const exported = () => new StepExporter(store, view).export({
      schema: 'IFC4', applyMutations: true, timeStamp: '2026-10-03T00:00:00',
    }).content;
    if (persisted) {
      const content = exported();
      store = await parser.parseColumnar(new Uint8Array(content).buffer, { disableWorkerScan: true });
      view = new MutablePropertyView(null, 'm');
      editor = new StoreEditor(store, view);
    }
    const before = structuredClone({ records: view.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() });
    const beforeBytes = exported();
    assert.equal(resolveLinearElementChain(store, view, editor, beam.beamId), null,
      'finite components with an unrepresentable magnitude must not expose a collapsed split axis');
    assert.deepEqual({ records: view.getNewEntities(), journal: view.getMutations(), next: view.peekNextExpressId() }, before);
    assert.deepEqual(exported(), beforeBytes);
    // A large but representable magnitude is supported; the refusal must stay narrow.
    editor.setPositionalAttribute(axisId, 0, [Number.MAX_VALUE, 0, 0]);
    const large = resolveLinearElementChain(store, view, editor, beam.beamId);
    assert.deepEqual(large?.axisDirection, [1, 0, 0]);
    assert.equal(large?.depth, 4);
    editor.setPositionalAttribute(axisId, 0, [1, 0, 0]);
    assert.deepEqual(resolveLinearElementChain(store, view, editor, beam.beamId)?.axisDirection, [1, 0, 0]);
  });
}
