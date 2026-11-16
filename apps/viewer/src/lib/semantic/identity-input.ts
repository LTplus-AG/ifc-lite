/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { GUID_PATTERN, LIMITS, assertIri, createResourceLinkStrategy, type ResourceIdentityLink } from '@ifc-lite/semantic';
export function parseResourceLinks(serialized: string): ResourceIdentityLink[] {
  if (new TextEncoder().encode(serialized).length > LIMITS.bytes) throw new Error('Resource links exceed byte limit');
  const raw: unknown = JSON.parse(serialized);
  if (!Array.isArray(raw) || raw.length > LIMITS.rows) throw new Error('Expected a bounded resource link array');
  const links = raw.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('resourceId' in item) || typeof item.resourceId !== 'string'
      || !('modelRevision' in item) || typeof item.modelRevision !== 'string' || !('GlobalId' in item) || typeof item.GlobalId !== 'string') throw new Error('Links require resourceId, modelRevision and GlobalId');
    assertIri(item.resourceId); assertIri(item.modelRevision);
    if (!new RegExp(GUID_PATTERN).test(item.GlobalId)) throw new Error('Invalid IFC GlobalId');
    return { resourceId: item.resourceId, modelRevision: item.modelRevision, GlobalId: item.GlobalId };
  });
  createResourceLinkStrategy(links);
  return links;
}
