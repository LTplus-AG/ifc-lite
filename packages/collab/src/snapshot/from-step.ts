/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Legacy STEP IFC → Y.Doc seeding (plan §4.1, §4.2).
 *
 * STEP IFC (IFC2X3 / IFC4 / IFC4X3) has no IFCX paths — only file-local,
 * unstable express ids (`#123`). The stable, file-independent key is the
 * `IfcGloballyUniqueId` (GUID). This seeder keys CRDT entities on the GUID
 * (`/<guid>`), so concurrent edits from peers converge regardless of how
 * each peer's parser numbered the file.
 *
 * Crucially, `@ifc-lite/collab` stays parser-independent: rather than depend
 * on `@ifc-lite/parser` and walk its columnar tables, this takes a minimal
 * structural `StepSeedSource`. The consumer (the viewer, which already has
 * the parser) adapts its `IfcDataStore` into this shape. Geometry is handled
 * separately (hybrid re-tessellation / mesh blobs — plan §4.2 consequence 2),
 * so this seeds entities, attributes, and property sets only.
 */

import type * as Y from 'yjs';
import { createEntity, setPropertyValue } from '../doc/entity.js';
import { SEED_ORIGIN, assertSchemaInvariants, metaMap } from '../doc/schema.js';
import type { PropertyValue } from '../doc/schema.js';

/** Schema versions the CRDT entity meta accepts (see `EntityMeta`). */
export type CollabSchemaVersion = 'ifc4' | 'ifc4x3' | 'ifc5';

/**
 * Map a raw STEP schema string to the CRDT's supported set. Legacy IFC2X3 and
 * IFC4 both map to `ifc4` (the spec's editing baseline); IFC4X3 → `ifc4x3`;
 * IFC5 → `ifc5`. Unknown → `ifc4`.
 */
function defaultSchemaVersion(schema: string | undefined): CollabSchemaVersion {
  switch ((schema ?? '').toUpperCase()) {
    case 'IFC4X3':
      return 'ifc4x3';
    case 'IFC5':
      return 'ifc5';
    default:
      return 'ifc4';
  }
}

/** A single STEP entity reduced to what the CRDT needs. */
export interface StepSeedEntity {
  /** IfcGloballyUniqueId (22-char). Entities without one are skipped. */
  guid: string;
  /** IFC class name, e.g. `IfcWallStandardCase`. */
  ifcClass: string;
  /** Core attributes (Name, Description, ObjectType, Tag, …). */
  attributes?: Record<string, unknown>;
  /** Property sets: psetName → propName → value. */
  psets?: Record<string, Record<string, PropertyValue>>;
}

/** Minimal model view the seeder consumes (the viewer adapts its store to this). */
export interface StepSeedSource {
  entities: Iterable<StepSeedEntity>;
  /** Optional file-level metadata mirrored into the doc meta map. */
  header?: {
    schema?: string;
    author?: string;
    timestamp?: string;
    fileName?: string;
  };
}

export interface SeedFromStepOptions {
  /** Origin tag for the seeding transaction. Defaults to `SEED_ORIGIN`. */
  origin?: unknown;
  /**
   * Map a raw IFC schema string (`IFC4`, `IFC4X3`, …) to the value stored as
   * the entity `schemaVersion`. Defaults to {@link defaultSchemaVersion}.
   */
  schemaVersionFor?: (schema: string | undefined) => CollabSchemaVersion;
}

export interface SeedFromStepResult {
  /** Number of entities seeded (those with a GUID). */
  seeded: number;
  /** Number of source entities skipped (no GUID). */
  skipped: number;
}

/** Path key for a STEP entity. Exported so the viewer's `resolveEntity` matches. */
export function guidToPath(guid: string): string {
  return `/${guid}`;
}

/**
 * Seed `doc` from a legacy STEP model. Idempotent: re-seeding the same source
 * into a doc that already has those GUIDs is a no-op (`createEntity` returns
 * the existing entity). Returns seed/skip counts.
 */
export function seedFromStep(
  doc: Y.Doc,
  source: StepSeedSource,
  opts: SeedFromStepOptions = {},
): SeedFromStepResult {
  assertSchemaInvariants(doc);
  const schemaVersionFor = opts.schemaVersionFor ?? defaultSchemaVersion;
  const schemaVersion = schemaVersionFor(source.header?.schema);

  let seeded = 0;
  let skipped = 0;

  doc.transact(() => {
    const meta = metaMap(doc);
    if (source.header) meta.set('stepHeader', source.header);

    for (const ent of source.entities) {
      if (!ent.guid) {
        skipped++;
        continue;
      }
      const path = guidToPath(ent.guid);
      createEntity(doc, path, {
        ifcClass: ent.ifcClass,
        attributes: ent.attributes ?? {},
        schemaVersion,
        meta: {
          ifcClass: ent.ifcClass,
          schemaVersion,
          createdAt: source.header?.timestamp ?? new Date().toISOString(),
          createdBy: source.header?.author,
        },
      });

      if (ent.psets) {
        for (const [psetName, props] of Object.entries(ent.psets)) {
          for (const [propName, value] of Object.entries(props)) {
            setPropertyValue(doc, path, psetName, propName, value);
          }
        }
      }
      seeded++;
    }
  }, opts.origin ?? SEED_ORIGIN);

  return { seeded, skipped };
}
