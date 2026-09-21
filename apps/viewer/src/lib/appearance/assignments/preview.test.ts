/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { FederationRegistry } from '../../../../../../packages/renderer/src/federation-registry.js';
import type { AppearancePlan } from '../planner-types.js';
import { toPreparedOverlayGlobalId } from '../../../store/federation-overlay-publication.js';
import { assignmentPreviewCreatedByModel } from './preview.js';

type PreviewStep = { modelId: string; plan: Pick<AppearancePlan, 'created'> };
const created = (expressId: number): AppearancePlan['created'][number] => ({
  expressId,
  type: 'IfcColourRgb',
  attributes: [],
});

it('keeps successive detached assignment batches virtual until their coordinated commit (#5050)', () => {
  const steps: PreviewStep[] = [
    { modelId: 'editable', plan: { created: [created(101), created(102)] } },
    { modelId: 'other', plan: { created: [created(51)] } },
    { modelId: 'editable', plan: { created: [created(103), created(104)] } },
  ];
  const ledger = assignmentPreviewCreatedByModel(steps);
  assert.deepEqual(ledger.get('editable')?.map(row => row.expressId), [101, 102, 103, 104]);
  assert.deepEqual(ledger.get('other')?.map(row => row.expressId), [51]);
  const registry = new FederationRegistry();
  registry.registerModel('prior', 50);
  registry.registerModel('editable', 100);
  const state = {
    models: new Map([['prior', { maxExpressId: 50 }], ['editable', { maxExpressId: 100 }]]),
    mutationViews: new Map([['editable', { getNewEntity: () => null }]]),
  };
  const offset = registry.getOffset('editable')!;
  for (const expressId of [101, 104]) {
    assert.equal(toPreparedOverlayGlobalId(registry, state, 'editable', ledger.get('editable')!, expressId), offset + expressId);
    assert.equal(registry.fromGlobalId(offset + expressId), null, `detached batch #${expressId} remains unpickable`);
    assert.throws(() => registry.toGlobalId('editable', expressId), /not published/);
  }
  assert.throws(
    () => assignmentPreviewCreatedByModel([{ modelId: 'editable', plan: { created: [created(101)] } },
      { modelId: 'editable', plan: { created: [created(103)] } }]),
    /contiguous/,
  );
});
