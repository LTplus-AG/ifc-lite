/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sample IFC4 → IFC4X3 schema migration (spec open #2).
 *
 * Demonstrates the migration plumb in `schema-version.ts`. Apps can
 * register this directly via `installIfc4ToIfc4x3Migration()` or
 * write their own equivalent.
 *
 * The transformation here is intentionally narrow:
 *   - rename common Pset attribute prefixes from `Pset_<…>::` to
 *     `bsi::ifc::v5a::Pset_<…>::` so they line up with IFCX namespacing.
 *
 * Real schema migrations are far more involved (entity-class renames,
 * attribute splits, unit changes). This sample shows the shape; the
 * full IFC4 → IFC4X3 migration registry is a v1.0+ task.
 */

import {
  registerSchemaMigration,
  type SchemaMigration,
} from '../doc/schema-version.js';
import type * as Y from 'yjs';

const PREFIX_FROM = /^Pset_([A-Za-z0-9_]+)::(.+)$/;

const ifc4ToIfc4x3: SchemaMigration = {
  from: 'ifc4',
  to: 'ifc4x3',
  apply(doc: Y.Doc) {
    const ents = doc.getMap('entities');
    ents.forEach((entUntyped) => {
      const entity = entUntyped as Y.Map<unknown>;
      const attrs = entity.get('attributes') as Y.Map<unknown> | undefined;
      if (!attrs) return;
      const renames: Array<{ from: string; to: string; value: unknown }> = [];
      attrs.forEach((value, key) => {
        const match = PREFIX_FROM.exec(key);
        if (!match) return;
        renames.push({
          from: key,
          to: `bsi::ifc::v5a::Pset_${match[1]}::${match[2]}`,
          value,
        });
      });
      for (const r of renames) {
        attrs.set(r.to, r.value);
        attrs.delete(r.from);
      }
    });
  },
};

/** Register the IFC4 → IFC4X3 migration. Idempotent within a process. */
export function installIfc4ToIfc4x3Migration(): SchemaMigration {
  registerSchemaMigration(ifc4ToIfc4x3);
  return ifc4ToIfc4x3;
}

export { ifc4ToIfc4x3 };
