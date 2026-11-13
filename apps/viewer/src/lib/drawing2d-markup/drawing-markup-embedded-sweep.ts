/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Remove the IfcLite markup annotations a model was OPENED with and the
 * session ABSORBED, so a save replaces them instead of adding a second copy
 * beside them.
 *
 * `removeDrawingMarkupFromStore` (`drawing-markup-save.ts`) sweeps only
 * overlay entities: the markup saved earlier in this session. A file that was
 * saved with markup, reopened and restored carries that markup as SOURCE
 * entities, and the restore puts the same items back into `Drawing2DState`.
 * Without this sweep, the next save wrote them again next to the embedded
 * ones (one measurement in, two annotations out).
 *
 * Only annotations whose content the session absorbed may go
 * (`drawing-markup-absorbed.ts`): the embedded restore does not always run,
 * and removing markup the user never saw deletes it. A tagged annotation
 * outside the absorbed set is kept, and the save writes its new markup beside
 * it.
 *
 * What is removed, all through `StoreEditor.removeEntity` tombstones:
 * - every live `IfcAnnotation` from the file whose current `ObjectType` is one
 *   of the `DRAWING_MARKUP_OBJECTTYPE` tags (any kind, so a kind added to
 *   that tag set is covered without touching this module) and whose identity
 *   ({@link embeddedMarkupIdentity}) is in the absorbed set;
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
import { getInheritanceChainAcrossSchemas, type IfcDataStore } from '@ifc-lite/parser';
import { DRAWING_MARKUP_OBJECTTYPE } from '@ifc-lite/create';
import { embeddedMarkupIdentity } from './drawing-markup-absorbed.js';
import { sourceMarkupGlobalId } from './drawing-markup-restore.js';

/** `IfcRoot.GlobalId`. */
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

/** Split a STEP argument list on top-level commas, keeping quoted strings and nested lists whole. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0, quoted = false;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quoted) {
      if (char === "'") {
        if (body[i + 1] === "'") i++;
        else quoted = false;
      }
    } else if (char === "'") quoted = true;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = body.slice(start).trim();
  if (last || parts.length > 0) parts.push(last);
  return parts;
}

/**
 * One STEP token as a value: a string literal (quotes stripped, `''`
 * unescaped; no other decoding, which the GlobalIds and markup tags compared
 * here never need), `null` for `$`/`*`, an id for `#N`, an array for a list,
 * the raw token otherwise (numbers, enums, typed values).
 */
function decodeToken(token: string): unknown {
  if (token === '$' || token === '*') return null;
  if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1).replace(/''/g, "'");
  const ref = refId(token);
  if (ref !== null) return ref;
  if (token.startsWith('(') && token.endsWith(')')) return splitTopLevel(token.slice(1, -1)).map(decodeToken);
  return token;
}

/** `#N` references in one exported STEP record, ignoring string literals. */
function recordRefs(text: string): number[] {
  const body = text.replace(/^\s*#\d+\s*=/, '').replace(/'(?:[^']|'')*'/g, "''");
  return [...body.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

/**
 * Reads entities exactly as the STEP exporter will write them: every decision
 * the sweep makes (an annotation's tag, a relationship's `RelatedObjects`, a
 * styled item's `Item`, the reference walk) comes from the one exported
 * record, so a retype, a named attribute edit or a positional edit is seen
 * the way the saved file states it rather than as the file was opened.
 */
class EffectiveReader {
  private readonly records = new Map<number, string | null>();

  constructor(private readonly store: IfcDataStore, private readonly view: MutablePropertyView) {}

  private sourceRef(id: number) {
    // @raw-entity-enumeration-ok point lookup of an id from the effective iterator or a live reference; tombstones are checked by callers
    return this.store.entityIndex.byId.get(id) ?? this.store.deferredEntityIndex?.get(id);
  }

  /** The record text the exporter writes for `id`, every pending edit applied. */
  private record(id: number): string | null {
    const cached = this.records.get(id);
    if (cached !== undefined) return cached;
    let text: string | null = null;
    const created = effectiveCreatedRecord(this.view, id, this.store.schemaVersion);
    if (created) text = created.text;
    else {
      const ref = this.sourceRef(id);
      if (ref) {
        const source = this.store.source.decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength);
        text = effectiveSourceRecord(this.view, id, source, ref.type, this.store.schemaVersion).text;
      }
    }
    this.records.set(id, text);
    return text;
  }

  isCreated(id: number): boolean {
    return this.view.getNewEntity(id) !== null;
  }

  type(id: number): string | undefined {
    const type = this.view.getEntityTypeMutation(id)?.newType ?? this.view.getNewEntity(id)?.type ?? this.sourceRef(id)?.type;
    return type?.toUpperCase();
  }

  /** The attribute values of the exported record (see {@link decodeToken}). */
  attributes(id: number): unknown[] | null {
    const text = this.record(id);
    if (!text) return null;
    const open = text.indexOf('(');
    const close = text.lastIndexOf(')');
    if (open < 0 || close < open) return null;
    return splitTopLevel(text.slice(open + 1, close)).map(decodeToken);
  }

  /** References the entity writes on export, slot edits included. */
  refs(id: number): number[] {
    const text = this.record(id);
    return text ? recordRefs(text) : [];
  }
}

/** A relationship's related side as ids: a list, or the single reference a named edit writes in its place. */
function relatedIds(value: unknown): (number | null)[] {
  if (Array.isArray(value)) return value.map(refId);
  const single = refId(value);
  return single === null ? [] : [single];
}

/**
 * Tombstone every IfcLite markup annotation the model was opened with whose
 * identity is in `absorbed`, and what only it uses (see the module doc).
 * Returns how many tagged annotations were removed.
 */
export function removeEmbeddedDrawingMarkup(store: IfcDataStore, editor: StoreEditor, absorbed: ReadonlySet<string>): number {
  if (absorbed.size === 0) return 0;
  const view = editor.getMutationView();
  const reader = new EffectiveReader(store, view);

  const annotations = new Set<number>();
  for (const { expressId } of iterateEffectiveEntityIds(store, view, ['IFCANNOTATION'])) {
    if (reader.isCreated(expressId)) continue;
    const attributes = reader.attributes(expressId);
    if (!MARKUP_TAGS.has(attributes?.[OBJECT_TYPE_INDEX])) continue;
    // Match on the GlobalId the restore recorded (the source one), not a pending edit of it.
    if (absorbed.has(embeddedMarkupIdentity(expressId, sourceMarkupGlobalId(store, expressId)))) annotations.add(expressId);
  }
  if (annotations.size === 0) return 0;

  const referencers = effectiveReferencers(store, view);
  const doomed = new Set(annotations);
  for (const annotation of annotations) {
    for (const parent of referencers(annotation)) {
      if (doomed.has(parent) || reader.type(parent) !== 'IFCRELDEFINESBYPROPERTIES') continue;
      const ids = relatedIds(reader.attributes(parent)?.[RELATED_OBJECTS_INDEX]);
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

  // A candidate falls once nothing alive references it. A styled item never
  // falls on its own: it falls together with the item it styles, so a
  // candidate styled item referencing `id` does not keep `id` alive as long
  // as nothing alive references that styled item either.
  const styledItem = (id: number): number | null | undefined =>
    reader.type(id) === 'IFCSTYLEDITEM' ? refId(reader.attributes(id)?.[STYLED_ITEM_INDEX]) : undefined;
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of candidates) {
      if (doomed.has(id) || styledItem(id) !== undefined) continue;
      const styles: number[] = [];
      const free = referencers(id).every((parent) => {
        if (doomed.has(parent)) return true;
        if (!candidates.has(parent) || styledItem(parent) !== id) return false;
        styles.push(parent);
        return referencers(parent).every((above) => doomed.has(above));
      });
      if (free) {
        doomed.add(id);
        for (const style of styles) doomed.add(style);
        changed = true;
      }
    }
  }

  for (const id of doomed) editor.removeEntity(id);
  return annotations.size;
}
