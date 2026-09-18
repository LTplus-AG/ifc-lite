/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Two store queries every diff adapter (CLI, MCP, viewer) needs identically
 * (issue #4955), kept here so three copies cannot drift:
 *
 * - {@link spatialContainerPath}: WHERE an element sits, as a stable NAME
 *   path from the project down to its nearest spatial container. Names, never
 *   GlobalIds — a from-scratch re-export re-GUIDs the storeys too.
 * - {@link authoredKeyValue}: an AUTHORED identifier the model maintains on
 *   purpose (`Tag`, or a property such as `Pset_Asset.AssetId`), which a
 *   downstream party may prefer over GlobalId as the cross-revision key.
 *
 * Neither knows anything about diffing. They answer "where is this" and
 * "what does this property say", which is what a parser is for.
 */

import type { SpatialHierarchy, SpatialNode } from '@ifc-lite/data';
import { extractPropertiesOnDemand, type IfcDataStore } from './columnar-parser.js';
import { EntityExtractor } from './entity-extractor.js';
import { getAttributeNamesAcrossSchemas } from './ifc-schema.js';

/** Per-hierarchy cache of node id → full name path, built on first use. */
const PATH_CACHE = new WeakMap<SpatialHierarchy, Map<number, string>>();

function nodeLabel(node: SpatialNode): string {
  return node.name.trim().length > 0 ? node.name.trim() : `#${node.expressId}`;
}

function pathsOf(hierarchy: SpatialHierarchy): Map<number, string> {
  const cached = PATH_CACHE.get(hierarchy);
  if (cached) return cached;
  const paths = new Map<number, string>();
  const walk = (node: SpatialNode, prefix: string): void => {
    const path = prefix ? `${prefix}/${nodeLabel(node)}` : nodeLabel(node);
    paths.set(node.expressId, path);
    for (const child of node.children) walk(child, path);
  };
  walk(hierarchy.project, '');
  PATH_CACHE.set(hierarchy, paths);
  return paths;
}

/**
 * The name path of the nearest spatial container of an element (`Project/
 * Building/Level 2/Room 204`), or `undefined` when the element is not
 * contained anywhere the hierarchy knows about. Prefers the finest container
 * (`elementToContainer`: a space or zone) over the storey.
 *
 * An unnamed node contributes its express id, which is NOT stable across
 * exports — a caller comparing two revisions should treat a path containing
 * `#` as weaker evidence. Names are trimmed so trailing whitespace an
 * authoring tool leaves behind does not split one storey into two.
 */
export function spatialContainerPath(store: IfcDataStore, expressId: number): string | undefined {
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy) return undefined;
  const container =
    hierarchy.elementToContainer?.get(expressId) ?? hierarchy.elementToStorey.get(expressId);
  if (container === undefined) return undefined;
  return pathsOf(hierarchy).get(container);
}

/** How an authored key is spelled: `Tag`, or `<PsetName>.<PropertyName>`. */
export interface AuthoredKeySpec {
  kind: 'tag' | 'property';
  pset?: string;
  property?: string;
}

/**
 * Parse a `--key-from` style spec. `Tag` (case-insensitive) reads the IfcElement
 * `Tag` attribute; anything containing a dot is `Pset.Property`. Returns
 * `undefined` for a spec that names neither.
 */
export function parseAuthoredKeySpec(spec: string): AuthoredKeySpec | undefined {
  const trimmed = spec.trim();
  if (trimmed.toLowerCase() === 'tag') return { kind: 'tag' };
  const dot = trimmed.indexOf('.');
  if (dot <= 0 || dot === trimmed.length - 1) return undefined;
  return { kind: 'property', pset: trimmed.slice(0, dot), property: trimmed.slice(dot + 1) };
}

/**
 * The authored key of one entity under a spec, or `undefined` when the entity
 * carries none (empty and whitespace-only values count as none — an empty
 * `Tag` is the schema's default, not an identity).
 */
export function authoredKeyValue(
  store: IfcDataStore,
  expressId: number,
  spec: AuthoredKeySpec,
  extractor: EntityExtractor = new EntityExtractor(store.source),
): string | undefined {
  let raw: unknown;
  if (spec.kind === 'tag') {
    const ifcType = store.entities.getTypeName(expressId);
    const index = getAttributeNamesAcrossSchemas(ifcType).indexOf('Tag');
    const ref = store.entityIndex.byId.get(expressId);
    if (index < 0 || !ref) return undefined;
    raw = extractor.extractEntity(ref)?.attributes?.[index];
  } else {
    const set = extractPropertiesOnDemand(store, expressId).find((pset) => pset.name === spec.pset);
    raw = set?.properties.find((property) => property.name === spec.property)?.value;
  }
  if (raw === null || raw === undefined) return undefined;
  const value = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
  return value.trim().length > 0 ? value.trim() : undefined;
}
