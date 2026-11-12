/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { createStyleEntityReader } from './style-entity-reader.js';

/** Inspect a borrowed source or overlay resource without bypassing pending edits. */
export function structuralReferenceAttributes(editor: StoreEditor, id: number, store?: IfcDataStore): readonly unknown[] {
  const record = store ? createStyleEntityReader(store, editor)(id) : editor.readNewEntity(id);
  if (!record) throw new Error(`Structural builder: pass the source store to validate referenced resource #${id}`);
  return record.attributes;
}
