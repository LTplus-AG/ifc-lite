/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Remove the IfcLite markup annotations a model was OPENED with, so a save
 * replaces them instead of adding a second copy beside them.
 *
 * `removeDrawingMarkupFromStore` (`drawing-markup-save.ts`) sweeps only
 * overlay entities: the markup saved earlier in this session. A file that was
 * saved with markup, reopened and restored carries that markup as SOURCE
 * entities, and the restore puts the same items back into `Drawing2DState`.
 * Without this sweep, the next save wrote them again next to the embedded
 * ones (one measurement in, two annotations out).
 *
 * What is removed, all through `StoreEditor.removeEntity` tombstones:
 * - every live `IfcAnnotation` from the file whose current `ObjectType` is one
 *   of the `DRAWING_MARKUP_OBJECTTYPE` tags (any kind, so a kind added to
 *   that tag set is covered without touching this module);
 * - each `IfcRelDefinesByProperties` that relates only such annotations (the
 *   writer's `Qto_IfcLiteMarkup` / `Pset_IfcLiteMarkup`);
 * - every entity reachable from those (placement, representation, items,
 *   points, the markup sub-context, the property/quantity set and its
 *   values, styled items on removed geometry) that nothing left alive still
 *   references. Sharing is decided by `effectiveReferencers`, the exporter's
 *   live reverse-reference lookup, so geometry another annotation or product
 *   reuses stays, and model infrastructure in `PROTECTED_TYPES` never goes.
 *
 * An `IfcAnnotation` without one of those tags is never removed. Other
 * relationships naming a removed annotation (a containment or group from
 * another tool) are left to the STEP exporter's deleted-endpoint filtering.
 */

import { iterateEffectiveEntityIds, type MutablePropertyView, type StoreEditor } from '@ifc-lite/mutations';
import { effectiveCreatedRecord, effectiveReferencers, effectiveSourceRecord } from '@ifc-lite/export';
import { EntityExtractor, getInheritanceChainAcrossSchemas, type IfcDataStore } from '@ifc-lite/parser';
import { DRAWING_MARKUP_OBJECTTYPE } from '@ifc-lite/create';

/** `IfcAnnotation.ObjectType`, the same slot across IFC2X3/IFC4/IFC4X3. */
const OBJECT_TYPE_INDEX = 4;
/** `IfcRelDefinesByProperties.RelatedObjects`. */
const RELATED_OBJECTS_INDEX = 4;
/** `IfcStyledItem.Item`. */
const STYLED_ITEM_INDEX = 0;

/** Shared model infrastructure a markup subgraph may reach but never owns. */
const PROTECTED_TYPES = new Set([
  'IFCPROJECT',
  'IFCGEOMETRICREPRESENTATIONCONTEXT',
  'IFCUNITASSIGNMENT',
  'IFCSIUNIT',
  'IFCCONVERSIONBASEDUNIT',
  'IFCOWNERHISTORY',
  'IFCPERSON',
  'IFCORGANIZATION',
  'IFCPERSONANDORGANIZATION',
  'IFCAPPLICATION',
]);

const MARKUP_TAGS = new Set<unknown>(Object.values(DRAWING_MARKUP_OBJECTTYPE));

function refId(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === 'string' && /^#[1-9][0-9]*$/.test(value)) return Number(value.slice(1));
  return null;
}

/** `#N` references in one exported STEP record, ignoring string literals. */
function recordRefs(text: string): number[] {
  const body = text.replace(/^\s*#\d+\s*=/, '').replace(/'(?:[^']|'')*'/g, "''");
  return [...body.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

class EffectiveReader {
  private readonly extractor: EntityExtractor | null;

  constructor(private readonly store: IfcDataStore, private readonly view: MutablePropertyView) {
    this.extractor = store.source.byteLength > 0 ? new EntityExtractor(store.source) : null;
  }

  private sourceRef(id: number) {
    // @raw-entity-enumeration-ok point lookup of an id from the effective iterator or a live reference; tombstones are checked by callers
    return this.store.entityIndex.byId.get(id) ?? this.store.deferredEntityIndex?.get(id);
  }

  isCreated(id: number): boolean {
    return this.view.getNewEntity(id) !== null;
  }

  type(id: number): string | undefined {
    const type = this.view.getEntityTypeMutation(id)?.newType ?? this.view.getNewEntity(id)?.type ?? this.sourceRef(id)?.type;
    return type?.toUpperCase();
  }

  /** The attribute list as authored or parsed, with slot edits applied. */
  attributes(id: number): unknown[] | null {
    const created = this.view.readNewEntity?.(id) ?? this.view.getNewEntity(id);
    let attributes: unknown[] | null = created ? [...created.attributes] : null;
    if (!attributes) {
      const ref = this.sourceRef(id);
      const entity = ref && this.extractor ? this.extractor.extractEntity(ref) : null;
      attributes = entity ? [...entity.attributes] : null;
    }
    if (!attributes) return null;
    for (const { name, value } of this.view.getAttributeMutationsForEntity(id)) {
      if (name === 'ObjectType') attributes[OBJECT_TYPE_INDEX] = value;
    }
    for (const [index, value] of this.view.getPositionalMutationsForEntity(id) ?? []) attributes[index] = value;
    return attributes;
  }

  /** References the entity writes on export, slot edits included. */
  refs(id: number): number[] {
    const created = effectiveCreatedRecord(this.view, id, this.store.schemaVersion);
    if (created) return recordRefs(created.text);
    const ref = this.sourceRef(id);
    if (!ref) return [];
    const text = this.store.source.decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength);
    return recordRefs(effectiveSourceRecord(this.view, id, text, ref.type, this.store.schemaVersion).text);
  }
}

/**
 * Tombstone every IfcLite markup annotation the model was opened with, and
 * what only it uses (see the module doc). Returns how many tagged
 * annotations were removed.
 */
export function removeEmbeddedDrawingMarkup(store: IfcDataStore, editor: StoreEditor): number {
  const view = editor.getMutationView();
  const reader = new EffectiveReader(store, view);

  const annotations = new Set<number>();
  for (const { expressId } of iterateEffectiveEntityIds(store, view, ['IFCANNOTATION'])) {
    if (reader.isCreated(expressId)) continue;
    if (MARKUP_TAGS.has(reader.attributes(expressId)?.[OBJECT_TYPE_INDEX])) annotations.add(expressId);
  }
  if (annotations.size === 0) return 0;

  const referencers = effectiveReferencers(store, view);
  const doomed = new Set(annotations);
  for (const annotation of annotations) {
    for (const parent of referencers(annotation)) {
      if (doomed.has(parent) || reader.type(parent) !== 'IFCRELDEFINESBYPROPERTIES') continue;
      const related = reader.attributes(parent)?.[RELATED_OBJECTS_INDEX];
      const ids = Array.isArray(related) ? related.map(refId) : [];
      if (ids.length > 0 && ids.every((id) => id !== null && annotations.has(id))) doomed.add(parent);
    }
  }

  // Candidates: everything reachable from the doomed roots, short of shared
  // infrastructure, plus styled items that only decorate a candidate.
  const candidates = new Set<number>();
  const queue = [...doomed];
  const visit = (id: number) => {
    if (doomed.has(id) || candidates.has(id) || !editor.hasEntity(id)) return;
    const type = reader.type(id);
    if (!type || PROTECTED_TYPES.has(type) || getInheritanceChainAcrossSchemas(type).includes('IfcObjectDefinition')) return;
    candidates.add(id);
    queue.push(id);
  };
  while (queue.length > 0) {
    const id = queue.pop() as number;
    for (const target of reader.refs(id)) visit(target);
    if (!doomed.has(id)) {
      for (const parent of referencers(id)) if (reader.type(parent) === 'IFCSTYLEDITEM') visit(parent);
    }
  }

  // A candidate falls once nothing alive references it; a styled item also
  // needs the item it styles to fall.
  const styledItem = (id: number): number | null | undefined =>
    reader.type(id) === 'IFCSTYLEDITEM' ? refId(reader.attributes(id)?.[STYLED_ITEM_INDEX]) : undefined;
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of candidates) {
      if (doomed.has(id)) continue;
      const styled = styledItem(id);
      if (styled !== undefined && (styled === null || !doomed.has(styled))) continue;
      if (referencers(id).every((parent) => doomed.has(parent))) {
        doomed.add(id);
        changed = true;
      }
    }
  }

  for (const id of doomed) editor.removeEntity(id);
  return annotations.size;
}
