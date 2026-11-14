/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isValidIfcGuid, uuidToIfcGuid, uuidV5 } from '@ifc-lite/encoding';
import { entityLineText, type PropertySetContext } from './step-property-set-readers.js';

/** Fixed namespace for persisted modelling records (#9352). Never change it. */
const INTERNAL_SET_NAMESPACE = '58a2ea4c-2894-483e-88ea-c0e49265b807';
const INTERNAL_SETS = new Set(['IfcLite_StoreyAttachment', 'IfcLite_CurtainWallLayout']);

/** Name both records from the live owner, so copies cannot reuse their source's ids. */
export function internalPropertySetIds(ctx: PropertySetContext, entityId: number, name: string): { set: string; rel: string } | null {
  if (!INTERNAL_SETS.has(name)) return null;
  const view = ctx.mutationView;
  const named = view?.getAttributeMutationsForEntity(entityId).find(m => m.name === 'GlobalId');
  const positional = view?.getPositionalMutationsForEntity(entityId);
  const created = view?.getNewEntity(entityId);
  const source = created ? null : entityLineText(ctx, entityId);
  const guid = positional?.has(0) ? positional.get(0) : named ? named.value : created?.attributes[0]
    ?? (source ? /^\s*#\d+\s*=\s*IFC\w+\s*\(\s*'([^']+)'/i.exec(source)?.[1] : null);
  if (typeof guid !== 'string' || !isValidIfcGuid(guid)) return null;
  const set = uuidToIfcGuid(uuidV5(INTERNAL_SET_NAMESPACE, `${guid}/${name}`));
  return { set, rel: uuidToIfcGuid(uuidV5(INTERNAL_SET_NAMESPACE, `${guid}/${name}/IfcRelDefinesByProperties`)) };
}
