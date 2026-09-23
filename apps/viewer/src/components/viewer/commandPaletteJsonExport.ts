/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Row-building for the viewer's JSON data export, shared by the command
 * palette's `export:json` entry and the toolbar's JSON export
 * (`useExportCommands`), so the two cannot drift. Pulled out of
 * `CommandPalette.tsx` (already at its module-size budget) so it can be
 * exercised without mounting the palette's React tree.
 *
 * Routes `type` through `@ifc-lite/data`'s `exactTypeName()`, the same
 * accessor #3475 put behind the Lists Class column
 * (`apps/viewer/src/lib/lists/adapter.ts`) and the Parquet `Type` column
 * (#3325) after both were caught naming the `IfcTypeEnum`-coalesced family
 * instead of the class an entity's STEP line actually declares
 * (`IFCDOORSTANDARDCASE` reporting as `IfcDoor`) (#3503).
 *
 * Exports the model as edited (#5249). Rows come from the shared
 * effective-entity iterator over the entity table's rows, so an entity
 * deleted this session is not exported and one created this session is. A
 * retyped entity reports its new class, a queued GlobalId/Name edit wins, and
 * properties are read through the mutation view, which applies pending pset
 * edits.
 */

import { exactTypeName } from '@ifc-lite/data';
import { normalizeIfcTypeName, resolveEffectiveEntityRecord, type IfcDataStore } from '@ifc-lite/parser';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';

/**
 * The entity table's rows are the source domain, and every row is exported
 * whatever its class (a row the table cannot name is still a row), so each
 * row answers a placeholder class. Rows are never matched by class here: the
 * export is untyped, and a row's reported type comes from `exactTypeName`.
 */
const TABLE_ROWS = {
  byType: new Map<string, readonly number[]>(),
  byId: { get: () => ({ type: 'IFC-LITE-TABLE-ROW' }) },
};

function stepText(value: unknown): string {
  if (typeof value !== 'string' || value === '$' || value === '*') return '';
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")
    ? trimmed.slice(1, -1).replace(/''/g, "'")
    : trimmed;
}

export function buildCommandPaletteJsonEntities(
  d: IfcDataStore,
  view: MutablePropertyView | null = null,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const source = { entityIndex: TABLE_ROWS };
  for (const { expressId: id, overlayCreated } of iterateEffectiveEntityIds(source, view, undefined, d.entities.expressId)) {
    const properties = view ? view.getForEntity(id) : d.properties.getForEntity(id);
    const created = overlayCreated ? view?.getNewEntity(id) : null;
    if (created && view) {
      // Effective class and name-relaid attributes, exactly as export writes them.
      const record = resolveEffectiveEntityRecord(created, {
        retype: view.getEntityTypeMutation(id)?.newType,
        named: view.getAttributeMutationsForEntity(id).map(({ name, value }) => [name, value] as const),
        positional: view.getPositionalMutationsForEntity(id) ?? [],
      }, d.schemaVersion);
      const field = (name: string) => stepText(record.attributes[record.names.indexOf(name)]);
      out.push({ expressId: id, globalId: field('GlobalId'), name: field('Name'), type: record.type, properties });
      continue;
    }
    const edits = new Map(view?.getAttributeMutationsForEntity(id).map(({ name, value }) => [name, value]) ?? []);
    const retype = view?.getEntityTypeMutation(id)?.newType;
    out.push({
      expressId: id,
      globalId: edits.get('GlobalId') ?? d.entities.getGlobalId(id),
      name: edits.get('Name') ?? d.entities.getName(id),
      type: retype ? normalizeIfcTypeName(retype) : exactTypeName(d.entities, id),
      properties,
    });
  }
  return out;
}
