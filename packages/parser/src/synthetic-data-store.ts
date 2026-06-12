/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  StringTable,
  EntityTableBuilder,
  PropertyTableBuilder,
  QuantityTableBuilder,
  RelationshipGraphBuilder,
} from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import type { EntityRef } from './types.js';
import { attachDataStoreAccessors, type IfcStoreData } from './data-store-accessors.js';

/**
 * A single entity row for a synthetic store. Each spec becomes a real row in
 * the {@link EntityTable}, so the table's own `getTypeName` / `getName` /
 * `getGlobalId` / `getTypeEnum` closures serve it — no hand-rolled accessor
 * shims, no casts.
 */
export interface SyntheticEntity {
  expressId: number;
  /** IFC type name, e.g. `'IfcGeographicElement'`. Matched case-insensitively. */
  type: string;
  globalId?: string;
  name?: string;
  /** Sets the `HAS_GEOMETRY` flag so `entities.hasGeometry()` returns true. */
  hasGeometry?: boolean;
}

export interface SyntheticDataStoreOptions {
  schemaVersion: IfcDataStore['schemaVersion'];
  fileSize: number;
  /**
   * Display entity count. Defaults to the number of `entities`. The GLB path
   * overrides this with its mesh count — the synthetic store carries no entity
   * rows but still wants to report N renderable meshes to the UI.
   */
  entityCount?: number;
  /**
   * Source bytes for lazy entity extraction. Defaults to empty; with an empty
   * source `getEntity` safely returns `null` (the entity table still answers
   * type/name/globalId queries from its columns).
   */
  source?: Uint8Array;
  /** Synthetic entity rows; omit (or pass `[]`) for an entity-less store. */
  entities?: SyntheticEntity[];
}

/**
 * Build a fully-typed {@link IfcDataStore} for synthetic / non-STEP models
 * (GLB meshes, point-cloud scans) without any `as unknown as IfcDataStore`
 * escape hatch.
 *
 * The data tables are real {@link @ifc-lite/data} tables built from their
 * builders, and the four lazy accessors are wired by
 * {@link attachDataStoreAccessors} — the same single source of truth the
 * columnar parse, worker transport, and cache restore use. Because the result
 * is assembled as a typed {@link IfcStoreData}, a future required member of
 * `IfcDataStore` becomes a compile error here instead of a silent
 * `TypeError: store.getProperties is not a function` at runtime on the
 * GLB / point-cloud ingest flow (the crash class from #950 / #1004).
 */
export function createSyntheticDataStore(opts: SyntheticDataStoreOptions): IfcDataStore {
  const strings = new StringTable();
  const specs = opts.entities ?? [];

  const entityBuilder = new EntityTableBuilder(specs.length, strings);
  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();

  for (const spec of specs) {
    entityBuilder.add(
      spec.expressId,
      spec.type,
      spec.globalId ?? '',
      spec.name ?? '',
      '',
      '',
      spec.hasGeometry ?? false,
    );
    // Empty byte range: the source is synthetic, so `getEntity` resolves the
    // ref then extracts nothing (returns null) rather than throwing.
    byId.set(spec.expressId, {
      expressId: spec.expressId,
      type: spec.type,
      byteOffset: 0,
      byteLength: 0,
      lineNumber: 0,
    });
    const upper = spec.type.toUpperCase();
    const ids = byType.get(upper);
    if (ids) ids.push(spec.expressId);
    else byType.set(upper, [spec.expressId]);
  }

  const storeData: IfcStoreData = {
    schemaVersion: opts.schemaVersion,
    entityCount: opts.entityCount ?? specs.length,
    fileSize: opts.fileSize,
    parseTime: 0,
    source: opts.source ?? new Uint8Array(0),
    entityIndex: { byId, byType },
    strings,
    entities: entityBuilder.build(),
    properties: new PropertyTableBuilder(strings).build(),
    quantities: new QuantityTableBuilder(strings).build(),
    relationships: new RelationshipGraphBuilder().build(),
  };

  return attachDataStoreAccessors(storeData);
}
