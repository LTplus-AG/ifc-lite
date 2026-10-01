/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IfcCreator } from '@ifc-lite/create';
import { PROFILE_ID, VOCAB, type SemanticDocument } from './types';

export const DEMO_BASE = 'https://example.org/ifc-lite/pilot/';
export const DEMO_REVISIONS = [DEMO_BASE + 'revision/1', DEMO_BASE + 'revision/2'];
/** Authored, deterministic IFC fixture. Real solids, not simulated viewer meshes. */
export function pilotModel(revision: number) {
  let guid = 0;
  const creator = new IfcCreator({ Name: 'Linked records pilot', Timestamp: 0,
    GuidSource: () => (++guid).toString(16).padStart(22, '0') });
  const storey = creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const doors = [0, 1, 2].map(index => creator.addIfcDoor(storey, {
    Name: `Pilot door ${index + 1}`, Position: [index * 2, revision * 3, 0], Width: 0.9, Height: 2.1,
  }));
  const { content } = creator.toIfc();
  const GlobalIds = doors.map(id => {
    const match = content.match(new RegExp(`#${id}=IFCDOOR\\('([^']+)'`));
    if (!match) throw new Error('Pilot creator did not emit a door GlobalId');
    return match[1];
  });
  return { content, GlobalIds, doors };
}
export function pilotDocument(): SemanticDocument {
  const { GlobalIds } = pilotModel(0);
  const id = (name: string) => DEMO_BASE + name;
  return { profile: PROFILE_ID, source: id('original-demo'), completeness: 'complete', resources: [
    { id: id('building'), type: 'Building', label: 'Pilot building' },
    { id: id('logbook'), type: 'Logbook', label: 'Building logbook', buildingId: id('building') },
    { id: id('batch'), type: 'Product', label: 'Shared door batch', granularity: 'batch', passportId: id('batch-passport'), fireRating: 'EI30', dictionaryUri: id('concept/fire-door') },
    { id: id('item'), type: 'Product', label: 'Individual door', granularity: 'item', passportId: id('item-passport'), fireRating: 'EI60', dictionaryUri: id('concept/fire-door') },
    { id: id('batch-passport'), type: 'Passport', label: 'Batch passport', productId: id('batch'), granularity: 'batch' },
    { id: id('item-passport'), type: 'Passport', label: 'Item passport', productId: id('item'), granularity: 'item' },
    ...GlobalIds.map((GlobalId, index) => ({ id: id(`installation/${index + 1}`), type: 'Installation' as const,
      label: `Installed door ${index + 1}`, buildingId: id('building'), productId: id(index === 2 ? 'item' : 'batch'),
      GlobalId, modelRevision: DEMO_REVISIONS[0], ...(index === 0 ? { replacesId: id('previous') } : {}) })),
    { id: id('previous'), type: 'Installation', label: 'Previous revision door', buildingId: id('building'), productId: id('batch'),
      GlobalId: GlobalIds[0], modelRevision: DEMO_REVISIONS[1] },
    { id: id('unmatched'), type: 'Installation', label: 'Not in either model', buildingId: id('building'), productId: id('batch'), GlobalId: '0000000000000000000999' },
    { id: id('inspection'), type: 'Inspection', label: 'Inspection evidence', installationId: id('installation/1'), evidenceId: id('inspection.pdf') },
    { id: id('incomplete-passport'), type: 'Passport', label: 'Incomplete passport: missing product and granularity' },
  ] };
}
export const PILOT_QUERY = `PREFIX pilot: <${VOCAB}>
SELECT ?id ?type ?label ?GlobalId ?modelRevision ?buildingId ?productId ?passportId ?granularity ?fireRating ?installationId ?replacesId ?evidenceId ?dictionaryUri
WHERE {
  ?id a ?type ; pilot:label ?label .
  OPTIONAL { ?id pilot:GlobalId ?GlobalId }
  OPTIONAL { ?id pilot:modelRevision ?modelRevision }
  OPTIONAL { ?id pilot:buildingId ?buildingId }
  OPTIONAL { ?id pilot:productId ?productId }
  OPTIONAL { ?id pilot:passportId ?passportId }
  OPTIONAL { ?id pilot:granularity ?granularity }
  OPTIONAL { ?id pilot:fireRating ?fireRating }
  OPTIONAL { ?id pilot:installationId ?installationId }
  OPTIONAL { ?id pilot:replacesId ?replacesId }
  OPTIONAL { ?id pilot:evidenceId ?evidenceId }
  OPTIONAL { ?id pilot:dictionaryUri ?dictionaryUri }
} LIMIT 5000`;
