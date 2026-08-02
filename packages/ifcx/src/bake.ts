/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bake: materialize a layer stack into a single tombstone-free IFCX
 * document for tools unaware of the `ifclite::` namespace.
 *
 * Tools that don't understand deletion overlays would compose tombstoned
 * entities as present; baking resolves the whole stack (including
 * tombstones and inherits) and emits one self-contained document.
 *
 * Spec: docs/architecture/layer-prs/02-layer-format.md §2.3,
 *       09-cli.md (`ifc layer bake`).
 */

import type { ComposedNode, IfcxFile, IfcxNode, ImportNode, IfcxSchema } from './types.js';
import { IFCLITE_ATTR } from './types.js';
import { composeIfcx } from './composition.js';

/**
 * `ifclite::` keys that are layer bookkeeping (resolved or meaningless
 * once baked) as opposed to data carriers: classifications, materials,
 * and geometry refs (#1031) are persistent content and must survive a
 * bake or the round-trip back through `seedFromIfcx` silently loses
 * those structured branches.
 */
const BAKE_STRIPPED_PREFIXES = [IFCLITE_ATTR.DELETED, IFCLITE_ATTR.DERIVED];

export interface BakeOptions {
  /** Header id for the baked document (default: generated). */
  id?: string;
  /** Author recorded in the baked header. */
  author?: string;
  /** Timestamp recorded in the baked header (default: now, ISO 8601). */
  timestamp?: string;
  /** dataVersion recorded in the baked header. */
  dataVersion?: string;
}

/**
 * Compose an ordered layer stack (weakest first, strongest last — the same
 * order `composeIfcx` resolves "later wins") and materialize the result as
 * a flat, tombstone-free IFCX document.
 *
 * The output carries no `ifclite::` *bookkeeping*: deletion overlays are
 * resolved (deleted subtrees are gone) and derived-cache markers are
 * dropped, while persistent data carriers (classifications, materials,
 * geometry refs) survive. Inherits are resolved into plain attributes.
 */
export function bakeLayers(layers: IfcxFile[], options: BakeOptions = {}): IfcxFile {
  if (layers.length === 0) {
    throw new Error('bakeLayers requires at least one layer');
  }

  // Concatenating data arrays weakest-first matches composeIfcx's
  // later-wins layer semantics, and composeIfcx applies tombstones.
  const merged: IfcxFile = {
    header: layers[layers.length - 1].header,
    imports: dedupeImports(layers),
    schemas: mergeSchemas(layers),
    data: layers.flatMap((layer) => layer.data),
  };
  const composed = composeIfcx(merged);

  const data: IfcxNode[] = [];
  for (const node of composed.values()) {
    data.push(materializeNode(node));
  }
  data.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    header: {
      id: options.id ?? `baked-${Date.now().toString(36)}`,
      ifcxVersion: layers[0].header.ifcxVersion,
      dataVersion: options.dataVersion ?? layers[layers.length - 1].header.dataVersion,
      author: options.author ?? 'ifc-lite bake',
      timestamp: options.timestamp ?? new Date().toISOString(),
    },
    imports: dedupeImports(layers),
    schemas: mergeSchemas(layers),
    data,
  };
}

function materializeNode(node: ComposedNode): IfcxNode {
  const out: IfcxNode = { path: node.path };

  if (node.children.size > 0) {
    const children: Record<string, string> = {};
    for (const [name, child] of node.children) {
      children[name] = child.path;
    }
    out.children = children;
  }

  const attributes: Record<string, unknown> = {};
  for (const [key, value] of node.attributes) {
    if (BAKE_STRIPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    attributes[key] = value;
  }
  if (Object.keys(attributes).length > 0) {
    out.attributes = attributes;
  }

  return out;
}

function dedupeImports(layers: IfcxFile[]): ImportNode[] {
  const byUri = new Map<string, ImportNode>();
  for (const layer of layers) {
    for (const imp of layer.imports) {
      if (!byUri.has(imp.uri)) byUri.set(imp.uri, imp);
    }
  }
  return [...byUri.values()];
}

function mergeSchemas(layers: IfcxFile[]): Record<string, IfcxSchema> {
  const schemas: Record<string, IfcxSchema> = {};
  for (const layer of layers) {
    Object.assign(schemas, layer.schemas);
  }
  return schemas;
}
