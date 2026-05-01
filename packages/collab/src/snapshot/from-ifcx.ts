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
import { SEED_ORIGIN, assertSchemaInvariants, metaMap } from '../doc/schema.js';

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
      const attributes: Record<string, unknown> = node.attributes ? { ...node.attributes } : {};
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

      createEntity(doc, path, {
        ifcClass,
        attributes,
        children,
        inherits,
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
