/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { snapshotAttribute } from './imported-snapshot.js';
import { ATTR, type ComposedNode, type UsdMesh, type UsdTransform } from './types.js';
import { getFrameLineage, type TraversalFrame } from './traversal.js';
import type { IfcxPointSource } from '@ifc-lite/pointcloud';
import type { TransformStack, ImportedOperationIdentity } from './imported-kernel.js';

/** Authored JSON numbers, before the compatibility display staging in Rust. */
export function appendSourceTransform(node: ComposedNode, parent: TransformStack): TransformStack {
  const source = (node.attributes.get(ATTR.TRANSFORM) as UsdTransform | undefined)?.transform;
  if (!source) return parent;
  // Preserve absent matrix cells: Rust applies the historical diagonal defaults.
  // Copy without Float32Array so large translations and local coefficients survive.
  // Nullish cells have always meant identity defaults in IFCX. Resolve those
  // format defaults in f64; the untouched authored attribute remains in nodes.
  const matrix = Array.from({ length: 4 }, (_, row) =>
    Array.from({ length: 4 }, (_, col) => source[row]?.[col] ?? (row === col ? 1 : 0)));
  return [...parent, matrix];
}

export interface ImportedNodeSource {
  readonly attributes: ReadonlyMap<string, unknown>;
  readonly attributeSources?: ReadonlyMap<string, unknown>;
  readonly contributingLayers?: ReadonlySet<string>;
}

export interface ImportedOccurrence {
  readonly identity: ImportedOperationIdentity;
  readonly ordinal: number;
  readonly path: string;
  readonly lineage: readonly { path: string; edgeName: string | null }[];
  readonly transforms: TransformStack;
  readonly definition: UsdMesh;
}

/**
 * Import-local source authority. Definitions are copied once per composed node,
 * not reconstructed from presented buffers. Occurrences retain traversal edges
 * separately from entity ids (which are importer ids, never STEP references).
 * Composition and asset objects remain owned by the existing format composer.
 */
export interface ImportedPointOccurrence {
  readonly identity: ImportedOperationIdentity;
  readonly ordinal: number;
  readonly path: string;
  readonly lineage: readonly { path: string; edgeName: string | null }[];
  readonly transforms: TransformStack;
  readonly definition: IfcxPointSource;
}

let nextStore = 1;

export class ImportedSourceDocument {
  readonly store = nextStore++;
  readonly revision = 1;
  private nextDefinition = 1;
  private nextOccurrence = 1;
  private definitionIds = new Map<string, number>();
  private snapshots = new WeakMap<object, unknown>();
  readonly definitions = new Map<string, UsdMesh>();
  readonly nodes = new Map<string, ImportedNodeSource>();
  readonly pointDefinitions = new Map<string, IfcxPointSource>();
  readonly pointOccurrences: ImportedPointOccurrence[] = [];

  admitPoints(frame: TraversalFrame, transforms: TransformStack, definition: IfcxPointSource, identity?: ImportedOperationIdentity): ImportedPointOccurrence {
    this.rememberLineage(frame);
    const existing = this.pointDefinitions.get(frame.node.path);
    definition = existing ?? definition;
    if (!existing) this.pointDefinitions.set(frame.node.path, definition);
    const occurrence: ImportedPointOccurrence = { identity: identity ?? this.identity(`points:${frame.node.path}`),
      ordinal: this.pointOccurrences.length, path: frame.node.path,
      lineage: getFrameLineage(frame).map(entry => ({ path: entry.node.path, edgeName: entry.edgeName })),
      transforms, definition };
    this.pointOccurrences.push(occurrence);
    return occurrence;
  }

  readonly occurrences: ImportedOccurrence[] = [];

  private identity(path: string): ImportedOperationIdentity {
    let definition = this.definitionIds.get(path);
    if (definition === undefined) { definition = this.nextDefinition++; this.definitionIds.set(path, definition); }
    return { store: this.store, revision: this.revision, definition, occurrence: this.nextOccurrence++ };
  }

  private rememberLineage(frame: TraversalFrame): void {
    for (const entry of getFrameLineage(frame)) {
      if (this.nodes.has(entry.node.path)) continue;
      const node = entry.node;
      const attributeSources = 'attributeSources' in node && node.attributeSources instanceof Map
        ? new Map<string, unknown>([...node.attributeSources].map(([key, value]): [string, unknown] =>
          [key, snapshotAttribute(value, this.snapshots)])) : undefined;
      const contributingLayers = 'contributingLayers' in node && node.contributingLayers instanceof Set
        ? new Set<string>(node.contributingLayers) : undefined;
      this.nodes.set(node.path, {
        attributes: new Map([...node.attributes].map(([key, value]) => [key, snapshotAttribute(value, this.snapshots)])),
        attributeSources, contributingLayers,
      });
    }
  }

  admitMesh(frame: TraversalFrame, transforms: TransformStack, source: UsdMesh, identity?: ImportedOperationIdentity): ImportedOccurrence {
    this.rememberLineage(frame);
    let definition = this.definitions.get(frame.node.path);
    if (!definition) {
      definition = snapshotAttribute(source, this.snapshots) as UsdMesh;
      this.definitions.set(frame.node.path, definition);
    }

    const occurrence: ImportedOccurrence = {
      identity: identity ?? this.identity(`mesh:${frame.node.path}`),
      ordinal: this.occurrences.length,
      path: frame.node.path,
      lineage: getFrameLineage(frame).map(entry => ({ path: entry.node.path, edgeName: entry.edgeName })),
      transforms,
      definition,
    };
    this.occurrences.push(occurrence);
    return occurrence;
  }
}

// Retain authored definitions for exactly as long as their presented import.
// This internal service avoids adding fields to the published MeshData surface.
const documents = new WeakMap<object, ImportedSourceDocument>();
export function retainImportedSource(owner: object, source: ImportedSourceDocument): void {
  documents.set(owner, source);
}
export function importedSourceFor(owner: object): ImportedSourceDocument | undefined {
  return documents.get(owner);
}
