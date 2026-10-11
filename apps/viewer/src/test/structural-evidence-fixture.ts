/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getAttributeNames, extractStructuralOnDemand } from '@ifc-lite/parser';
import type { IfcAttributeValue } from '@ifc-lite/data';
import { parseStep, seedModel, exportAndReparse } from './properties-panel-harness';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { useViewerStore } from '@/store';

export async function structuralEvidenceFixture(save = true) {
  const file = await parseStep(await readFile(new URL('../../public/samples/building-architecture.ifc', import.meta.url), 'utf8'));
  seedModel('native', 0, file, 52);
  const view = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(view); view.setExpressIdWatermark(100_000);
  const author = (type: string, fields: Record<string, IfcAttributeValue>) => view.createEntity(type,
    getAttributeNames(type).map(name => fields[name] ?? null));
  // Explicit authored structural additions to the real SketchUp sample, not original model facts.
  const member = author('IfcStructuralSurfaceMember', { GlobalId: '0000000000000000000006', Name: 'Authored analysis surface', PredefinedType: '.SHELL.', Thickness: 0.25 });
  const load = author('IfcStructuralLoadSingleForce', { Name: 'Authored force', ForceX: 1234, ForceY: 0, ForceZ: 0, MomentX: 0, MomentY: 0, MomentZ: 0 });
  const action = author('IfcStructuralSurfaceAction', { GlobalId: '0000000000000000000007', Name: 'Authored structural action', AppliedLoad: `#${load.expressId}`, GlobalOrLocal: '.GLOBAL_COORDS.', DestabilizingLoad: '.F.', PredefinedType: '.CONST.' });
  const relation = author('IfcRelConnectsStructuralActivity', { GlobalId: '0000000000000000000008', RelatingElement: `#${member.expressId}`, RelatedStructuralActivity: `#${action.expressId}` });
  const saved = await exportAndReparse('native', file);
  const native = extractStructuralOnDemand(saved);
  assert.equal(native.members[0].thickness, 0.25); assert.equal(native.activities[0].appliedLoad?.components.ForceX, 1234);
  assert.equal(saved.getEntity(relation.expressId)?.attributes[5], action.expressId);
  if (save) useViewerStore.setState({ mutationViews: new Map() });
  seedModel('native', 0, save ? saved : file, member.expressId);
  return { file: save ? saved : file, original: file, saved, view, memberId: member.expressId, loadId: load.expressId, actionId: action.expressId, relationId: relation.expressId };
}
