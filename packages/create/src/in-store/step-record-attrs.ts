/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A record read from the file in the form `StoreEditor.addEntity` writes, so
 * it can be written again as a new record (#8447: a copy with its own shape).
 *
 * The parsed attributes cannot be used for this: they give an entity
 * reference and an INTEGER the same number, so `CoordIndex` of an
 * `IfcTriangulatedFaceSet` would come back as references, and a REAL that is
 * a whole number would come back as an INTEGER. This reads the record's own
 * STEP text instead: `#n` references, `{ real }` for every literal with a
 * decimal point or exponent, `.ENUM.`, decoded strings, typed values and
 * nested lists, with the session's positional edits and retype on top.
 */

import { decodeStepStringLiteral, splitStepTopLevel } from '@ifc-lite/encoding';
import type { IfcAttributeValue, MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';

export interface FileRecord {
  readonly type: string;
  readonly attributes: IfcAttributeValue[];
}

/** The file's record `id` with this session's edits on it; null when the file does not hold it or it does not read. */
export function readFileRecord(store: IfcDataStore, view: MutablePropertyView, id: number): FileRecord | null {
  // @raw-entity-enumeration-ok point lookup of one record's source bytes; the session's positional edits are laid over it
  const ref = store.entityIndex.byId.get(id) ?? store.deferredEntityIndex?.get(id);
  if (!ref || view.isDeleted(id)) return null;
  const text = store.source.decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength);
  const open = text.indexOf('('), close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  let attributes: IfcAttributeValue[];
  try {
    attributes = parseStepAttributeList(text.slice(open + 1, close));
  } catch (cause) {
    throw new Error(`Cannot copy STEP record #${id}`, { cause });
  }
  for (const [index, value] of view.getPositionalMutationsForEntity(id) ?? []) attributes[index] = value as IfcAttributeValue;
  return { type: view.getEntityTypeMutation(id)?.newType ?? ref.type, attributes };
}

/** The attributes between a record's outer parentheses. Throws on a token it does not know. */
export function parseStepAttributeList(inner: string): IfcAttributeValue[] {
  if (inner.trim() === '') return [];
  return splitStepTopLevel(inner).map(parseStepToken);
}

function parseStepToken(token: string): IfcAttributeValue {
  const t = token.trim();
  if (t === '$') return null;
  if (t === '*') return '*';
  if (/^#\d+$/.test(t)) return t;
  if (/^\.[A-Z0-9_]+\.$/i.test(t)) return t.toUpperCase();
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return decodeStepStringLiteral(t.slice(1, -1));
  if (t.startsWith('(') && t.endsWith(')')) return parseStepAttributeList(t.slice(1, -1));
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) {
    const value = Number(t);
    if (!Number.isFinite(value)) throw new Error(`Unreadable STEP number ${t}`);
    return /[.eE]/.test(t) ? { real: value } : value;
  }
  const typed = /^([A-Za-z][A-Za-z0-9_]*)\((.*)\)$/s.exec(t);
  if (typed) {
    const inner = parseStepToken(typed[2]);
    const value = inner !== null && typeof inner === 'object' && 'real' in inner ? inner.real
      : inner === '.T.' ? true : inner === '.F.' ? false : inner;
    if (Array.isArray(value)) {
      const name = typed[1].toUpperCase();
      if ((name !== 'IFCLINEINDEX' && name !== 'IFCARCINDEX')
        || !value.every((index): index is number => typeof index === 'number' && Number.isSafeInteger(index) && index > 0)
        || (name === 'IFCLINEINDEX' ? value.length < 2 : value.length !== 3)) {
        throw new Error(`Unsupported STEP typed aggregate ${t}`);
      }
      return { typed: { type: name, value } };
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`Unsupported STEP typed value ${t}`);
    }
    return { typed: { type: typed[1].toUpperCase(), value } };
  }
  throw new Error(`Unreadable STEP token ${t}`);
}
