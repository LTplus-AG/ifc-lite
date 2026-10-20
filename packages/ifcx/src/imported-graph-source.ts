/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { ATTR, type ComposedNode, type UsdTransform } from './types.js';
import { POINTCLOUD_ATTR_KEYS } from '@ifc-lite/pointcloud';
import { getNodeLineage, type TraversalFrame } from './traversal.js';
import { ImportWriter } from './imported-wire.js';

/** Snapshot ordered source edges. This enumerates source, never geometry work. */
export function sourceGraph(composed: Map<string, ComposedNode>) {
  const nodes = [...composed.values()];
  const indices = new Map(nodes.map((node, index) => [node, index]));
  for (let index = 0; index < nodes.length; index++) {
    for (const child of nodes[index].children.values()) {
      if (!indices.has(child)) { indices.set(child, nodes.length); nodes.push(child); }
    }
  }
  return { nodes, indices };
}

/** Only called when Rust requests this reached node's original attributes. */
export function writeNodeSource(writer: ImportWriter, node: ComposedNode, pathToId: Map<string, number>): void {
  const customData = node.attributes.get('customdata') as { originalStepInstance?: unknown } | undefined;
  const original = customData?.originalStepInstance;
  const visibility = (node.attributes.get(ATTR.VISIBILITY) as { visibility?: unknown } | undefined)?.visibility;
  const diffuse = node.attributes.get(ATTR.DIFFUSE_COLOR) as number[] | undefined;
  const opacity = node.attributes.get(ATTR.OPACITY) as number | undefined;
  const matrix = (node.attributes.get(ATTR.TRANSFORM) as UsdTransform | undefined)?.transform;
  writer.u32(pathToId.get(node.path) === undefined ? 0 : 1)
    .optionalString(typeof original === 'string' ? original : undefined)
    .optionalString(typeof visibility === 'string' ? visibility : undefined).u32(diffuse ? 1 : 0);
  if (diffuse) writer.values([diffuse[0], diffuse[1], diffuse[2]]);
  writer.f64(opacity ?? 1).u32(matrix ? 1 : 0);
  if (matrix) writer.matrix(matrix);
  writer.u32(node.attributes.get(ATTR.MESH) ? 1 : 0);
  writer.u32([...POINTCLOUD_ATTR_KEYS].some(key => node.attributes.has(key)) ? 1 : 0);
}

/** Existing format presentation authority; Rust chooses when it is reached. */
export function resolveImportedColor(frame: TraversalFrame): [number, number, number, number] | null {
  const lineage = getNodeLineage(frame);
  for (let i = lineage.length - 1; i >= 0; i--) {
    const diffuse = lineage[i].attributes.get(ATTR.DIFFUSE_COLOR) as number[] | undefined;
    const opacity = lineage[i].attributes.get(ATTR.OPACITY) as number | undefined;
    if (diffuse) { const [r, g, b] = diffuse; return [r, g, b, opacity ?? 1]; }
  }
  return null;
}
