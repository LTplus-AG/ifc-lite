/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, afterEach, it } from 'node:test';
import { PropertyValueType } from '@ifc-lite/data';
import { seedModelingSession, MODEL_ID, STOREY, UPPER_STOREY } from '@/test/modeling-session-fixture';
import { useViewerStore } from '@/store';
import { render, cleanup } from '@/test/render';
import { PropertyEditor } from '../PropertyEditor';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WallTopRow } from './WallTopRow';
import { storeyAttachmentDisplay } from '@/lib/actions/storey-attachment-display';
beforeEach(async () => { await seedModelingSession(); });
afterEach(cleanup);
it('#9296 shows the wall target name and elevation, with its GlobalId in details', () => {
  const s = useViewerStore.getState();
  const result = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 });
  assert.ok('expressId' in result);
  const guid = s.models.get(MODEL_ID)!.ifcDataStore!.entities.getGlobalId(UPPER_STOREY)!;
  s.setProperty(MODEL_ID, result.expressId, 'IfcLite_StoreyAttachment', 'TopConstraint', guid, PropertyValueType.Label);
  const ui = render(<WallTopRow modelId={MODEL_ID} wallId={result.expressId} />);
  assert.match(ui.textContent ?? '', /To L1 \(\+3.00 m\)/);
  assert.equal(ui.querySelector('[title]')?.getAttribute('title'), guid);
  const properties = render(<TooltipProvider><PropertyEditor modelId={MODEL_ID} entityId={result.expressId} psetName="IfcLite_StoreyAttachment" propName="TopConstraint" currentValue={guid} /></TooltipProvider>);
  assert.match(properties.textContent ?? '', /To L1 \(\+3.00 m\)/);
  const display = storeyAttachmentDisplay(useViewerStore.getState(), MODEL_ID, result.expressId, 'NextStoreyAbove');
  assert.equal(display?.text, `To L1 (+3.00 m)`);
  assert.equal(storeyAttachmentDisplay(useViewerStore.getState(), MODEL_ID, result.expressId, 'unknown-binding-kind'), null);
  assert.equal(storeyAttachmentDisplay(useViewerStore.getState(), MODEL_ID, result.expressId, 'missing-global-id'), null);
});
