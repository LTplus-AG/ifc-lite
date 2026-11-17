/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shape a copy of a product carries (`copyProductInStore`).
 *
 *   - `'shared'` (the default, as Duplicate has always done): a shape created
 *     this session is copied record by record, so the copy can be reshaped on
 *     its own; a shape read from the file is shared by reference.
 *   - `'own'` (#8447): a shape read from the file is copied record by record
 *     too, from its STEP text (`readFileRecord`), so the copy and its source
 *     can be edited apart.
 *
 * Either way the styles on the copied items are copied with them. With
 * `'own'`, representation contexts and a type's representation maps stay
 * shared references: they belong to the model, not to the one shape. A shape over
 * `MAX_CLONED_SHAPE_RECORDS` records refuses the copy (it throws) rather than
 * silently sharing, so a caller that asked for its own shape never gets a
 * shared one.
 */

import type { IfcAttributeValue, StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { remapRefs, type LiveRead } from './copy-frame.js';
import { asRef, refList } from './style-entity-reader.js';
import { readFileRecord } from './step-record-attrs.js';

export type CopyShape = 'shared' | 'own';

/** A shape bigger than this is not deep-copied (a pathological graph): the copy is refused. */
export const MAX_CLONED_SHAPE_RECORDS = 50_000;

/** Records a copied shape keeps naming rather than copying. */
const SHARED_SHAPE_RECORDS = new Set(['IFCGEOMETRICREPRESENTATIONCONTEXT', 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT', 'IFCREPRESENTATIONMAP']);

export interface ShapeCopyContext {
  readonly store: IfcDataStore;
  readonly editor: StoreEditor;
  readonly read: LiveRead;
  readonly styledBy: ReadonlyMap<number, number>;
}

/** The copy of `shapeId`, or null when the shape is shared (or there is none). */
export function cloneShape(ctx: ShapeCopyContext, shapeId: number | null, mode: CopyShape = 'shared'): number | null {
  const view = ctx.editor.getMutationView();
  const created = (id: number) => view.getNewEntity(id) !== null && !view.isDeleted(id);
  const records = new Map<number, { type: string; attributes: readonly unknown[] } | null>();
  const record = (id: number) => {
    if (!records.has(id)) records.set(id, created(id) ? ctx.read(id) : mode === 'own' ? readFileRecord(ctx.store, view, id) : null);
    return records.get(id)!;
  };
  // `'shared'` keeps copying exactly what it always has: the session's own records.
  const copied = mode === 'shared' ? created : (id: number) => {
    const rec = record(id);
    if (!rec) throw new Error(`Cannot copy unreadable shape record #${id}`);
    return !SHARED_SHAPE_RECORDS.has(rec.type.toUpperCase());
  };
  if (shapeId === null || !copied(shapeId)) return null;
  const copies = new Map<number, number>();
  const expanded = new Set<number>();
  // Iterative post-order: children are written before the records that name them.
  const stack = [shapeId];
  while (stack.length > 0) {
    const id = stack[stack.length - 1];
    const rec = copies.has(id) ? null : record(id);
    if (!rec) { stack.pop(); continue; }
    if (!expanded.has(id)) {
      expanded.add(id);
      if (expanded.size > MAX_CLONED_SHAPE_RECORDS) throw new Error(`The shape of this element is too large to copy (over ${MAX_CLONED_SHAPE_RECORDS} records)`);
      for (const child of childRefs(rec.attributes)) {
        if (!copied(child)) continue;
        if (expanded.has(child) && !copies.has(child)) throw new Error(`Cannot copy cyclic shape at #${child}`);
        if (!expanded.has(child)) stack.push(child);
      }
      continue;
    }
    stack.pop();
    copies.set(id, ctx.editor.addEntity(rec.type, rec.attributes.map((a) => remapRefs(a, copies))).expressId);
  }
  for (const [from, to] of copies) {
    const styledItem = ctx.styledBy.get(from);
    const style = styledItem === undefined ? null : ctx.read(styledItem);
    // IfcStyledItem(Item, Styles, Name): the same styles, on the copied item.
    if (style) ctx.editor.addEntity('IfcStyledItem', [`#${to}`, refList(style.attributes[1]).map((id) => `#${id}`), (style.attributes[2] ?? null) as IfcAttributeValue]);
  }
  return copies.get(shapeId) ?? null;
}

function childRefs(values: readonly unknown[]): number[] {
  const out: number[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === 'string') {
      const id = asRef(value);
      if (id !== null) out.push(id);
    }
  };
  values.forEach(visit);
  return out;
}
