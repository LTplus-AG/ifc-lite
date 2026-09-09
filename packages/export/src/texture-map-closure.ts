/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { asSourceBytes, type IfcSourceBytes } from '@ifc-lite/parser';
import { refGroupFromArg } from './reference-collector.js';
import { readEntityArgs, type EntityByteRangeIndex } from './subset-entity-reader.js';
import type { EffectiveEntityIndex } from './effective-index.js';

export const TEXTURE_MAP_TYPES = ['IFCINDEXEDTRIANGLETEXTUREMAP', 'IFCINDEXEDPOLYGONALTEXTUREMAP', 'IFCTEXTUREMAP'] as const;

/** #4243: rescue by MappedTo geometry, never by a shared image or UV resource.
 * Effective reference groups replace overridden targets; refsOf intentionally
 * unions original and edited refs and would resurrect a hidden map after retargeting.
 */
export function textureMapTarget(
  source: Uint8Array | IfcSourceBytes,
  index: EntityByteRangeIndex & Pick<EffectiveEntityIndex, 'refGroupsOf'>,
  expressId: number,
): number | undefined {
  const sourceGroups = readEntityArgs({ source: asSourceBytes(source) }, index, expressId)?.args.map(refGroupFromArg);
  const groups = index.refGroupsOf?.(expressId, sourceGroups) ?? sourceGroups ?? [];
  // EXPRESS places MappedTo after inherited Maps (indexed maps), or after
  // Maps and Vertices (IfcTextureMap). Do not narrow its IfcFace target by
  // concrete type: IfcFaceSurface and IfcAdvancedFace are valid targets too.
  const type = index.get(expressId)?.type?.toUpperCase();
  const target = groups[type === 'IFCTEXTUREMAP' ? 2 : 1];
  return typeof target === 'number' ? target : undefined;
}
