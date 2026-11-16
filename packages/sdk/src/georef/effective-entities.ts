/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place that answers "which entities of this class exist, and what do
 * their attributes say" for georeferencing, from the session's effective view:
 * the source file, plus what the session created, minus what it deleted, with
 * retypes and attribute edits applied. A count taken from the source alone
 * ("how many IfcSites are there") would disagree with the file the session will
 * write as soon as the generic API creates or deletes one.
 *
 * Attributes come from the record as the exporter writes it
 * (`effectiveSourceRecord` / `effectiveCreatedRecord`), parsed by the same
 * extractor as a source record. Where that cannot be done reliably (an edit the
 * exporter declines or cannot place, a retyped record, an unreadable record) the
 * answer is `unknown`, never a guess.
 */

import { effectiveCreatedRecord, effectiveSourceRecord } from '@ifc-lite/export';
import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';

export type EffectiveAttributes = { attributes: unknown[] } | { unknown: string };

export interface EffectiveEntities {
  /** Ids whose effective class is `type` (UPPERCASE STEP name). */
  idsOf(type: string): number[];
  /** The effective attributes of `id`, or why they cannot be known. */
  attributesOf(id: number): EffectiveAttributes;
}

export function effectiveEntities(store: IfcDataStore, view: MutablePropertyView | null): EffectiveEntities {
  const schema = String(store.schemaVersion ?? '');
  const retypes = view?.getTypeMutations() ?? new Map<number, { newType: string }>();
  const created = view ? view.getNewEntities() : [];
  const extractor = store.source?.length ? new EntityExtractor(store.source) : null;
  const parse = (id: number, type: string, text: string): EffectiveAttributes => {
    const bytes = new TextEncoder().encode(text);
    const attributes = new EntityExtractor(bytes).extractEntity({ expressId: id, type, byteOffset: 0, byteLength: bytes.length, lineNumber: 0 })?.attributes;
    return attributes ? { attributes } : { unknown: `#${id} (${type}) does not parse` };
  };
  // A record the extractor cannot read is not an empty one: the fact built from it is unknown, never a guess.
  const read = (id: number, type: string, attributes: unknown[] | undefined): EffectiveAttributes => (attributes ? { attributes } : { unknown: `#${id} (${type}) could not be read` });
  return {
    idsOf(type) {
      const want = type.toUpperCase();
      const ids = new Set<number>();
      // @raw-entity-enumeration-ok the source ids of one class: tombstones, retypes and creations are applied below, this is the effective index's own construction
      for (const id of store.entityIndex?.byType.get(want) ?? []) if (!view?.isDeleted(id) && !retypes.has(id)) ids.add(id);
      for (const [id, m] of retypes) if (!view?.isDeleted(id) && m.newType.toUpperCase() === want) ids.add(id);
      for (const e of created) if (!view?.isDeleted(e.expressId) && (retypes.get(e.expressId)?.newType ?? e.type).toUpperCase() === want) ids.add(e.expressId);
      return [...ids];
    },
    attributesOf(id) {
      if (!view) {
        // @raw-entity-enumeration-ok point read of one source record, for a session without a mutation view
        const ref = store.entityIndex?.byId.get(id);
        return ref && extractor ? read(id, ref.type, extractor.extractEntity(ref)?.attributes) : { unknown: `#${id} is not in the file` };
      }
      if (view.getNewEntity(id)) {
        const record = effectiveCreatedRecord(view, id, schema);
        if (!record) return { unknown: `#${id} has no record` };
        return record.notWritten.length > 0 ? { unknown: `#${id} (${record.type}): ${record.notWritten.join('; ')}` } : parse(id, record.type, record.text);
      }
      // @raw-entity-enumeration-ok point read of one source record the facts already selected; its edits are applied through the exporter's own record layout
      const ref = store.entityIndex?.byId.get(id);
      if (!ref || !extractor) return { unknown: `#${id} is not in the file` };
      if (view.getEntityTypeMutation(id)) return { unknown: `#${id} (${ref.type}) was retyped, so its attributes follow another layout` };
      const edited = (view.getPositionalMutationsForEntity(id)?.size ?? 0) > 0 || view.getAttributeMutationsForEntity(id).length > 0;
      if (!edited) return read(id, ref.type, extractor.extractEntity(ref)?.attributes);
      const text = new TextDecoder().decode(store.source.slice(ref.byteOffset, ref.byteOffset + ref.byteLength));
      const record = effectiveSourceRecord(view, id, text, ref.type, schema);
      return record.notWritten.length > 0 ? { unknown: `#${id} (${ref.type}): ${record.notWritten.join('; ')}` } : parse(id, ref.type, record.text);
    },
  };
}
