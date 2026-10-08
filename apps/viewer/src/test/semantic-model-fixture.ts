/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IfcParser } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { DEMO_REVISIONS, pilotDocument, pilotModel } from '@/lib/semantic/demo';
import { useSemanticSession } from '@/lib/semantic/session';

/**
 * The authored linked-records pilot (3 IfcDoor) parsed for real and loaded as
 * `count` federated models, with the pilot revisions associated to m0, m1 and
 * the pilot records loaded as the session document, and the Linked records
 * chunk loaded (as it is whenever the user has attached a text).
 */
export async function seedSemanticModels(count = 2) {
  // The evidence register reads the session only once the lazy Linked records chunk has handed it over.
  await import('@/components/viewer/SemanticPanel');
  const authored = pilotModel(0);
  const data = await new IfcParser().parseColumnar(new TextEncoder().encode(authored.content).buffer, { disableWorkerScan: true });
  const models = Array.from({ length: count }, (_, index) => ({ ...fixtureModel(`m${index}`, { idOffset: index * 1_000_000 }),
    ifcDataStore: data, maxExpressId: Math.max(...data.entities.expressId) }));
  useViewerStore.setState({ ...fixtureModels(...models), ifcDataStore: data,
    selectedEntityId: null, selectedEntityIds: new Set(), selectedEntity: null, selectedEntities: [], mutationViews: new Map() });
  const revisions = new Map(DEMO_REVISIONS.slice(0, count).map((uri, index) => [uri, `m${index}`]));
  const document = pilotDocument();
  useSemanticSession.setState({ document, revisions, retrievedAt: '2026-01-01T00:00:00.000Z' });
  return { authored, revisions, document };
}
