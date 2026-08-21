/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Y.Doc → IFCX snapshot.
 *
 * Round-trips with `seedFromIfcx`: seeding a doc, snapshotting, then
 * seeding a fresh doc from the snapshot must produce structurally equal
 * Y states (verified by tests).
 *
 * Structured branches (psets / quantities / classifications / materials
 * / geometryRef) fold into namespaced attributes on the wire — see
 * `structured-attrs.ts` for the representation contract (#1031).
 */

import type { IfcxFile, IfcxHeader, IfcxNode, ImportNode } from '@ifc-lite/ifcx';
import * as Y from 'yjs';
import { entityToJSON, iterEntities } from '../doc/entity.js';
import { metaMap } from '../doc/schema.js';
import { flattenStructuredBranches, geometryRecordLookup } from './structured-attrs.js';
import { IFCX_VERSION } from '@ifc-lite/ifcx';

export interface SnapshotOptions {
  author?: string;
  /** Override timestamp; defaults to Date.now(). */
  timestamp?: string;
  /** Override the data version string. */
  dataVersion?: string;
  /** Override the file id. */
  id?: string;
  /** Override the IFCX version string. Defaults to whatever was seeded. */
  ifcxVersion?: string;
  /** Stable child-key ordering (defaults to insertion order from the Y.Map). */
  sortChildren?: boolean;
}

export function snapshotToIfcx(doc: Y.Doc, options: SnapshotOptions = {}): IfcxFile {
  const meta = metaMap(doc);
  const seededHeader = (meta.get('header') as IfcxHeader | undefined) ?? undefined;
  const seededImports = (meta.get('imports') as ImportNode[] | undefined) ?? [];
  const seededSchemas =
    (meta.get('schemas') as Record<string, unknown> | undefined) ?? {};

  const header: IfcxHeader = {
    id: options.id ?? seededHeader?.id ?? 'ifc-lite/collab/snapshot',
    ifcxVersion: options.ifcxVersion ?? seededHeader?.ifcxVersion ?? IFCX_VERSION,
    dataVersion: options.dataVersion ?? seededHeader?.dataVersion ?? '1.0.0',
    author: options.author ?? seededHeader?.author ?? 'ifc-lite/collab',
    timestamp: options.timestamp ?? new Date().toISOString(),
  };

  const data: IfcxNode[] = [];
  const geometryRecordFor = geometryRecordLookup(doc);
  for (const [path, entity] of iterEntities(doc)) {
    const json = entityToJSON(entity);
    const node: IfcxNode = { path };

    const childrenKeys = options.sortChildren
      ? Object.keys(json.children).sort()
      : Object.keys(json.children);
    if (childrenKeys.length > 0) {
      node.children = {};
      for (const k of childrenKeys) node.children[k] = json.children[k];
    }

    const inheritsKeys = options.sortChildren
      ? Object.keys(json.inherits).sort()
      : Object.keys(json.inherits);
    if (inheritsKeys.length > 0) {
      node.inherits = {};
      for (const k of inheritsKeys) node.inherits[k] = json.inherits[k];
    }

    // `seedFromIfcx` treats a literal `null` attribute value as an IFCX
    // removal opinion and never stores it (see from-ifcx.ts) — so a
    // doc attribute holding `null` (e.g. a root attribute the user
    // cleared, mirrored via mutation-bridge.ts's `toScalar`) must not
    // be emitted as-is: the very next seed would silently drop it,
    // disagreeing with what this writer just produced. Match the
    // reader's contract on the way out instead of losing the key on
    // the next round-trip.
    const flattened = flattenStructuredBranches(json, { geometryRecordFor });
    const attributes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(flattened)) {
      if (value !== null) attributes[key] = value;
    }
    if (Object.keys(attributes).length > 0) {
      node.attributes = attributes;
    }

    data.push(node);
  }

  return {
    header,
    imports: seededImports as IfcxFile['imports'],
    schemas: seededSchemas as IfcxFile['schemas'],
    data,
  };
}

/** Serialize an IfcxFile to a string. */
export function serializeIfcx(file: IfcxFile, pretty = true): string {
  return pretty ? JSON.stringify(file, null, 2) : JSON.stringify(file);
}
