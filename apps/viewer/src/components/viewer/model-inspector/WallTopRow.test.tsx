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
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { commitStoreyOp } from '@/store/slices/mutation-storey';
import { ModelInspectorPanel } from './ModelInspectorPanel';
import { WallTopRow } from './WallTopRow';
import { storeyAttachmentDisplay } from '@/lib/actions/storey-attachment-display';
let restoreRemesh = () => {};
beforeEach(async () => { await seedModelingSession(); restoreRemesh = setRequestRemesh(() => {}); useViewerStore.getState().enterModelWorkspace({ modelId: MODEL_ID, storeyId: STOREY }); });
afterEach(() => { cleanup(); useViewerStore.getState().exitModelWorkspace(); restoreRemesh(); });
it('#9296 shows the wall target name and elevation, with its GlobalId in details', () => {
  const s = useViewerStore.getState();
  const result = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 });
  assert.ok('expressId' in result);
  const guid = s.models.get(MODEL_ID)!.ifcDataStore!.entities.getGlobalId(UPPER_STOREY)!;
  s.setProperty(MODEL_ID, result.expressId, 'IfcLite_StoreyAttachment', 'TopConstraint', guid, PropertyValueType.Label);
  const ui = render(<WallTopRow modelId={MODEL_ID} wallId={result.expressId} />);
  assert.match(ui.textContent ?? '', /To L1 \(\+3.00 m\)/);
  assert.equal(ui.querySelector('[title]')?.getAttribute('title'), guid);
  for (const value of [guid, ['IFCLABEL', guid], `IFCLABEL,${guid}`]) {
  const properties = render(<TooltipProvider><PropertyEditor modelId={MODEL_ID} entityId={result.expressId} psetName="IfcLite_StoreyAttachment" propName="TopConstraint" currentValue={value} /></TooltipProvider>);
  assert.match(properties.textContent ?? '', /To L1 \(\+3.00 m\)/);
  assert.equal(storeyAttachmentDisplay(useViewerStore.getState(), MODEL_ID, result.expressId, value)?.text, 'To L1 (+3.00 m)');
  if (typeof value === 'string') {
    s.setProperty(MODEL_ID, result.expressId, 'IfcLite_StoreyAttachment', 'TopConstraint', value, PropertyValueType.Label);
    const row = render(<WallTopRow modelId={MODEL_ID} wallId={result.expressId} />);
    assert.match(row.textContent ?? '', /To L1 \(\+3.00 m\)/);
  }
  }
  const display = storeyAttachmentDisplay(useViewerStore.getState(), MODEL_ID, result.expressId, 'NextStoreyAbove');
  assert.equal(display?.text, `To L1 (+3.00 m)`);
  assert.equal(storeyAttachmentDisplay(useViewerStore.getState(), MODEL_ID, result.expressId, 'unknown-binding-kind'), null);
  assert.equal(storeyAttachmentDisplay(useViewerStore.getState(), MODEL_ID, result.expressId, 'missing-global-id'), null);
});

it('#9334 a known next-storey binding without an upper storey explains its fixed fallback', () => {
  const s = useViewerStore.getState();
  const wall = s.addWall(MODEL_ID, UPPER_STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 });
  assert.ok('expressId' in wall);
  s.setProperty(MODEL_ID, wall.expressId, 'IfcLite_StoreyAttachment', 'TopConstraint', 'NextStoreyAbove', PropertyValueType.Label);
  const ui = render(<WallTopRow modelId={MODEL_ID} wallId={wall.expressId} />);
  assert.match(ui.textContent ?? '', /Next storey above \(none yet\) · 3.00 m fixed/);
  assert.equal(ui.textContent?.includes('NextStoreyAbove'), false);
});
it('#9334 a storey-derived height is read-only and names the level that drives it', () => {
  const s = useViewerStore.getState();
  const wall = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 });
  assert.ok('expressId' in wall);
  const guid = s.models.get(MODEL_ID)!.ifcDataStore!.entities.getGlobalId(UPPER_STOREY)!;
  s.setProperty(MODEL_ID, wall.expressId, 'IfcLite_StoreyAttachment', 'TopConstraint', guid, PropertyValueType.Label);
  s.setSelectedEntityId(wall.expressId);
  const ui = render(<ModelInspectorPanel />);
  assert.equal(ui.querySelector<HTMLInputElement>('[aria-label="Height in metres"]')?.readOnly, true);
  assert.match(ui.textContent ?? '', /from L1/);
});

it('#9334 a relative top resolves the current next storey after insertion, not the recorded old GUID', () => {
  const s = useViewerStore.getState();
  const wall = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 });
  assert.ok('expressId' in wall);
  const guid = s.models.get(MODEL_ID)!.ifcDataStore!.entities.getGlobalId(UPPER_STOREY)!;
  s.setProperty(MODEL_ID, wall.expressId, 'IfcLite_StoreyAttachment', 'TopConstraint', guid, PropertyValueType.Label);
  s.setProperty(MODEL_ID, wall.expressId, 'IfcLite_StoreyAttachment', 'TopBinding', 'Relative', PropertyValueType.Label);
  assert.ok(commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'add', params: { Name: 'Inserted', Elevation: 1.5, referenceStoreyId: STOREY } }).ok);
  const ui = render(<WallTopRow modelId={MODEL_ID} wallId={wall.expressId} />);
  assert.match(ui.textContent ?? '', /To Inserted \(\+1.50 m\)/);
  const properties = render(<TooltipProvider><PropertyEditor modelId={MODEL_ID} entityId={wall.expressId} psetName="IfcLite_StoreyAttachment" propName="TopConstraint" currentValue={guid} /></TooltipProvider>);
  assert.match(properties.textContent ?? '', /To Inserted \(\+1.50 m\)/);
});
