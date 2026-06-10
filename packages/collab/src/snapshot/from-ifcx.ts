/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFCX → Y.Doc seeding.
 *
 * Idempotent: seeding the same buffer into a fresh Y.Doc twice produces
 * the same state. Used both at session start and when resetting from a
 * snapshot.
 */

import type { IfcxFile } from '@ifc-lite/ifcx';
import * as Y from 'yjs';
import { createEntity } from '../doc/entity.js';
import { createGeometry, type GeometryType } from '../doc/geometry.js';
import { SEED_ORIGIN, assertSchemaInvariants, metaMap } from '../doc/schema.js';
import { inflateStructuredAttributes } from './structured-attrs.js';

export interface SeedOptions {
  /** Origin tag for the seeding transaction. Defaults to SEED_ORIGIN. */
  origin?: unknown;
  /** If true, clear any existing top-level state before seeding. */
  reset?: boolean;
}

export type IfcxInput = ArrayBuffer | Uint8Array | string | IfcxFile;

/** Decode whatever the caller hands us into a parsed IfcxFile. */
export function parseIfcxInput(input: IfcxInput): IfcxFile {
  if (typeof input === 'string') {
    return JSON.parse(input) as IfcxFile;
  }
  if (input instanceof ArrayBuffer) {
    const text = new TextDecoder().decode(new Uint8Array(input));
    return JSON.parse(text) as IfcxFile;
  }
  if (input instanceof Uint8Array) {
    const text = new TextDecoder().decode(input);
    return JSON.parse(text) as IfcxFile;
  }
  return input;
}

/**
 * Seed `doc` with the contents of an IFCX file. Returns the parsed file
 * for callers that want to inspect headers / schemas.
 */
export function seedFromIfcx(doc: Y.Doc, input: IfcxInput, opts: SeedOptions = {}): IfcxFile {
  const file = parseIfcxInput(input);
  assertSchemaInvariants(doc);

  doc.transact(() => {
    if (opts.reset) {
      const ents = doc.getMap('entities');
      const rels = doc.getMap('relationships');
      const geom = doc.getMap('geometry');
      ents.clear();
      rels.clear();
      geom.clear();
    }

    // Stash file-level metadata so we can re-emit it during snapshotting.
    const meta = metaMap(doc);
    if (file.header) meta.set('header', file.header);
    if (file.imports) meta.set('imports', file.imports);
    if (file.schemas) meta.set('schemas', file.schemas);

    for (const node of file.data ?? []) {
      const path = node.path;
      if (!path) continue;
      // Null attribute values are removal opinions (minimal layers); with
      // nothing beneath them to remove, they mean "absent" — never store
      // them as values.
      const rawAttributes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.attributes ?? {})) {
        if (value !== null) rawAttributes[key] = value;
      }
      // Re-inflate structured branches the snapshot writer folded into
      // namespaced attributes (#1031); the shape-gated remainder stays
      // in the flat attributes branch.
      const inflated = inflateStructuredAttributes(rawAttributes);
      const children: Record<string, string> = {};
      if (node.children) {
        for (const [role, target] of Object.entries(node.children)) {
          if (typeof target === 'string') children[role] = target;
        }
      }
      const inherits: Record<string, string> = {};
      if (node.inherits) {
        for (const [role, target] of Object.entries(node.inherits)) {
          if (typeof target === 'string') inherits[role] = target;
        }
      }

      const ifcClass = readIfcClass(node.attributes);

      // A carrier with the embedded geometry record recreates the
      // geometry map entry, so the restored ref is never dangling.
      // Bare-id carriers keep pointing at out-of-band hydrated geometry.
      const carrier = inflated.geometryCarrier;
      if (carrier && typeof carrier.type === 'string' && typeof carrier.source === 'string') {
        createGeometry(doc, carrier.geomId, {
          type: carrier.type as GeometryType,
          source: carrier.source,
          blobHash: carrier.blobHash,
          params: carrier.params,
          bbox: carrier.bbox as [number, number, number, number, number, number] | undefined,
        });
      }

      createEntity(doc, path, {
        ifcClass,
        attributes: inflated.attributes,
        children,
        inherits,
        psets: inflated.psets,
        quantities: inflated.quantities,
        classifications: inflated.classifications,
        materials: inflated.materials,
        geometryRef: inflated.geometryRefRecord,
        meta: {
          ifcClass,
          schemaVersion: 'ifc5',
          createdAt: file.header?.timestamp ?? new Date().toISOString(),
          createdBy: file.header?.author,
        },
      });
    }
  }, opts.origin ?? SEED_ORIGIN);

  return file;
}

/** Read the IfcClass code out of the well-known `bsi::ifc::class` attribute. */
function readIfcClass(attributes: Record<string, unknown> | undefined): string | undefined {
  if (!attributes) return undefined;
  const cls = attributes['bsi::ifc::class'];
  if (cls && typeof cls === 'object' && 'code' in cls) {
    const code = (cls as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}
