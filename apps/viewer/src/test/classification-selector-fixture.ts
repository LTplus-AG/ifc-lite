/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Real authoring samples plus a stated named-association invariant (#7130). */
import { readFileSync } from 'node:fs';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from './store-fixture';
import { parseArtifactProposal, type ArtifactProposal } from '@/lib/assistant/artifacts/proposal-kinds';

export const DECLARED_SYSTEM_FIXTURE = new URL('../../../../tests/models/ara3d/tested_sample_project.ifc', import.meta.url);
export const UNNAMED_SYSTEM_FIXTURE = new URL('../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
export const CLASSIFICATION_SYSTEM_ID = 8800;

export function selectorAnswer(kind: ArtifactProposal['kind'], system: string): string {
  const base = { version: 1, kind, title: 'Classification selector #7130' };
  const groups = [{ combinator: 'AND', rules: [
    { kind: 'ifcType', op: 'in', values: ['IfcWall'] }, { kind: 'classification', system, op: 'isNotSet', value: '' },
  ] }];
  return JSON.stringify(kind === 'filter.proposal' ? { ...base, name: base.title, groups }
    : kind === 'list.proposal' ? { ...base, list: { name: base.title, entityTypes: ['IfcWall'], groups, columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }] } }
      : kind === 'lens.proposal' ? { ...base, lens: { name: base.title, rules: [{ name: 'Missing system', groups, action: 'colorize', color: '#E53935' }] } }
        : { ...base, chart: { type: 'bar', dimension: 'IfcType', measure: { agg: 'count' }, filter: { groups } } });
}

export function selectorProposal(kind: ArtifactProposal['kind'], system: string): ArtifactProposal {
  return parseArtifactProposal(selectorAnswer(kind, system), kind);
}

async function parse(bytes: Uint8Array): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
}

export function installClassificationModels(...stores: IfcDataStore[]): void {
  useViewerStore.setState({ ...fixtureModels(...stores.map((store, index) => {
    let maxExpressId = 0;
    // @raw-entity-enumeration-ok test fixture sizes each freshly parsed source's federation range before mutations
    for (const id of store.entities.expressId) maxExpressId = Math.max(maxExpressId, id);
    return { ...fixtureModel(`classification-${index}`, { idOffset: index * 1_000_000 }), ifcDataStore: store, maxExpressId };
  })), mutationViews: new Map(), mutationVersion: 0 });
}

export async function realClassificationModel(path: URL): Promise<IfcDataStore> {
  return parse(readFileSync(path));
}

/** Two real source walls receive named refs; the third remains unclassified. */
export async function namedClassificationModel(system = 'Uniclass 2015'): Promise<IfcDataStore> {
  const source = readFileSync(new URL('../../public/samples/building-architecture.ifc', import.meta.url), 'utf8');
  const parsed = await parse(new TextEncoder().encode(source));
  const walls = parsed.entities.expressId.filter(id => parsed.entities.getTypeName(id) === 'IfcWall');
  if (walls.length < 3) throw new Error('Committed authoring sample must have at least three walls');
  // A test-only IFC graph invariant, not an authoring-tool classification claim.
  const added = `#8800=IFCCLASSIFICATION('CSI','2015',$,'${system.replace(/'/g, "''")}',$,$,$);
#8801=IFCCLASSIFICATIONREFERENCE($,'EF_25_10','Wall',#8800,$,$);
#8802=IFCCLASSIFICATIONREFERENCE($,$,$,#8800,$,$);
#8810=IFCRELASSOCIATESCLASSIFICATION('0ClassifiedWall00000001',$,$,$,(#${walls[0]}),#8801);
#8811=IFCRELASSOCIATESCLASSIFICATION('0ClassifiedWall00000002',$,$,$,(#${walls[1]}),#8802);
`;
  return parse(new TextEncoder().encode(source.replace(/ENDSEC;\s*END-ISO-10303-21;\s*$/, `${added}ENDSEC;\nEND-ISO-10303-21;`)));
}
