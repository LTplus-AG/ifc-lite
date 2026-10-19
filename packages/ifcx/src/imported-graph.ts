/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { decodeIfcxPointSource } from '@ifc-lite/pointcloud';
import { ATTR, type ComposedNode, type UsdMesh } from './types.js';
import type { MeshData } from './geometry-extractor.js';
import type { PointCloudExtraction } from './pointcloud-extractor.js';
import type { TraversalFrame } from './traversal.js';
import { appendSourceTransform, ImportedSourceDocument, retainImportedSource } from './imported-source.js';
import type { TransformStack } from './imported-kernel.js';
import { stageUvs } from './imported-kernel.js';
import { ImportReader, ImportWriter } from './imported-wire.js';
import { sourceGraph, writeNodeSource, resolveImportedColor } from './imported-graph-source.js';
import { IFCX_APPEARANCE, IFCX_IMAGE, createIfcxImageDecoder, decodeIfcxAppearance } from './appearance-wire.js';

/**
 * The host supplies reached source/asset replies. Rust owns traversal, pass
 * ordering, eligibility, occurrence identity, deduplication, numerical operations
 * and completion. No host geometry walker or precomputed operation list exists.
 */
export function executeImportedGraph(composed: Map<string, ComposedNode>, pathToId: Map<string, number>, mode: 1 | 2 | 3) {
  const { nodes, indices } = sourceGraph(composed);
  const source = new ImportedSourceDocument();
  const open = new ImportWriter(100).u64(source.store).u64(source.revision).u32(mode).u32(composed.size).u32(nodes.length);
  for (const node of nodes) {
    open.identityString(node.path).u32(node.children.size);
    for (const [edge, child] of node.children) {
      const index = indices.get(child);
      if (index === undefined) throw new Error('Imported geometry: source graph changed during admission');
      open.identityString(edge).u32(index);
    }
  }
  const handle = open.run().u32();
  const meshes: MeshData[] = [];
  const pointClouds: PointCloudExtraction[] = [];
  const decodeImage = createIfcxImageDecoder();
  let frame: TraversalFrame | null = null;
  let transforms: TransformStack = [];
  try {
    for (;;) {
      const event = new ImportWriter(101).u32(handle).run();
      const kind = event.u32();
      if (kind === 0) break;
      const sequence = event.u32();
      const occurrence = event.u64();
      const nodeIndex = event.u32();
      const node = nodes[nodeIndex];
      if (!node) throw new Error('Imported geometry: invalid reached source identity');
      if (kind === 1) {
        ({ frame, transforms } = readFrame(event, nodes));
        const reply = new ImportWriter(102).u32(handle).u32(sequence);
        writeNodeSource(reply, node, pathToId);
        reply.run();
        continue;
      }
      const contextIndex = event.u32();
      const contextNode = nodes[contextIndex];
      if (!contextNode || !frame || frame.node !== node) throw new Error('Imported geometry: stale reached occurrence');
      const expressId = pathToId.get(contextNode.path);
      if (expressId === undefined) throw new Error('Imported geometry: context changed during admission');
      const ifcType = (contextNode.attributes.get(ATTR.CLASS) as { code?: string } | undefined)?.code;
      const identity = { store: source.store, revision: source.revision, definition: nodeIndex + 1, occurrence };
      if (kind === 2) {
        const transform = event.floats();
        readColor(event); // Rust's resolved numeric opinion; wire identity is JS-authoritative.
        const color = resolveImportedColor(frame);
        const key = [node.path, expressId, transform.length ? transform.join(',') : 'identity', color ? color.join(',') : 'default'].join('|');
        new ImportWriter(103).u32(handle).u32(sequence).identityString(key).run();
      } else if (kind === 3) {
        const raw = node.attributes.get(ATTR.MESH) as UsdMesh;
        const admitted = source.admitMesh(frame, transforms, raw, identity);
        const reply = new ImportWriter(104).u32(handle).u32(sequence);
        reply.rows(admitted.definition.points).values(admitted.definition.faceVertexIndices)
          .u32(admitted.definition.faceVertexCounts ? 1 : 0);
        if (admitted.definition.faceVertexCounts) reply.values(admitted.definition.faceVertexCounts);
        reply.u32(admitted.definition.normals ? 1 : 0);
        if (admitted.definition.normals) reply.rows(admitted.definition.normals);
        reply.run();
      } else if (kind === 4) {
        const points = source.pointDefinitions.get(node.path) ?? decodeIfcxPointSource(node.attributes);
        const reply = new ImportWriter(105).u32(handle).u32(sequence).u32(points ? 1 : 0);
        if (points) {
          source.admitPoints(frame, transforms, points, identity);
          reply.values(points.positions).u32(points.colors ? 1 : 0);
          if (points.colors) reply.values(points.colors);
          reply.f64(points.pointCount).string(points.sourcePrecision).string(points.sourceEncoding);
        }
        reply.run();
      } else if (kind === 5) {
        readColor(event);
        const mesh: MeshData = { expressId, ifcType, positions: event.floats(), normals: event.floats(),
          indices: event.indices(), color: resolveImportedColor(frame) ?? [0.8, 0.8, 0.8, 1] };
        const wire = node.attributes.get(IFCX_APPEARANCE);
        if (wire !== undefined) {
          const appearance = decodeIfcxAppearance(wire, mesh.positions.length / 3);
          const pixels = decodeImage(appearance.image.ref, composed.get(appearance.image.ref)?.attributes.get(IFCX_IMAGE));
          mesh.uvs = stageUvs(appearance.uvs);
          mesh.texture = { ...pixels, repeatS: appearance.repeatS, repeatT: appearance.repeatT };
        }
        retainImportedSource(mesh, source); retainImportedSource(mesh.positions, source);
        meshes.push(mesh);
        new ImportWriter(106).u32(handle).u32(sequence).run();
      } else if (kind === 6) {
        const positions = event.floats();
        const colors = event.u32() ? event.floats() : undefined;
        const cloud: PointCloudExtraction = { expressId, ifcType, positions, colors, pointCount: event.f64(),
          bbox: { min: event.triple(), max: event.triple() } };
        retainImportedSource(cloud, source); retainImportedSource(positions, source);
        pointClouds.push(cloud);
        new ImportWriter(106).u32(handle).u32(sequence).run();
      } else {
        throw new Error(`Imported geometry: invalid operation ${kind}`);
      }
    }
    retainImportedSource(meshes, source); retainImportedSource(pointClouds, source);
    return { meshes, pointClouds };
  } finally {
    new ImportWriter(107).u32(handle).run();
  }
}

function readColor(event: ImportReader): [number, number, number, number] | null {
  return event.u32() ? [event.f64(), event.f64(), event.f64(), event.f64()] : null;
}
function readFrame(event: ImportReader, nodes: ComposedNode[]): { frame: TraversalFrame; transforms: TransformStack } {
  let frame: TraversalFrame | null = null;
  let transforms: TransformStack = [];
  const count = event.u32();
  for (let index = 0; index < count; index++) {
    const node = nodes[event.u32()];
    const edgeName = event.optionalIdentityString() ?? null;
    if (!node) throw new Error('Imported geometry: invalid source lineage');
    frame = { node, parent: frame, edgeName, depth: index };
    transforms = appendSourceTransform(node, transforms);
  }
  if (!frame) throw new Error('Imported geometry: empty source lineage');
  return { frame, transforms };
}
