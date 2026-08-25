/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Apply overlay attribute + positional overrides to an OVERLAY-CREATED
 * entity's argument list (#2006) — the sibling of `step-attribute-
 * mutations.ts`'s source-buffer pipeline that shares its two serialize
 * helpers (`step-attribute-serializers.ts`). Split out of
 * `step-attribute-mutations.ts` (#3184).
 */

import type { IfcAttributeValue } from '@ifc-lite/parser';
import { getAttributeNamesAcrossSchemas } from '@ifc-lite/parser';
import { splitTopLevelArgs } from './step-argument-parser.js';
import { getRealTypedSlots } from './attribute-real-slots.js';
import { serializeNamedAttribute, serializePositionalOverride } from './step-attribute-serializers.js';
import type { IfcSchemaVersion } from './schema-converter.js';

/**
 * Apply overlay attribute + positional overrides to an OVERLAY-CREATED
 * entity's argument list (#2006).
 *
 * Distinct from {@link applyAttributeMutations} / {@link applyPositionalMutations},
 * which rewrite a line read out of the source buffer. Here the whole line is
 * ours: it was serialized moments ago from the creation payload, so the
 * argument list is the authoring payload's, not the file's. That difference
 * is why this PADS — `entity_create` takes whatever positional list the
 * caller passes, so a wall authored with three arguments still has a real
 * `Tag` slot at index 7, and dropping the edit because the payload was short
 * would be the very data loss this fixes. The source-buffer path must not
 * pad: there a short line means a different schema, and growing a record we
 * did not author would corrupt it.
 *
 * Named and positional overrides resolve to a slot index up front and share
 * ONE padding rule. Two padding rules on one record is how the next bug
 * starts, and the argument for padding — the class is fixed at creation time,
 * so a short payload is partial authoring — never depended on which of the
 * two APIs queued the edit.
 */
export function applyOverlayEntityOverrides(
  argsText: string,
  entityType: string,
  attributeOverrides: Map<string, string> | null,
  positionalOverrides: Map<number, IfcAttributeValue> | null,
  schemaVersion: IfcSchemaVersion,
  onRejected?: (attrName: string, value: string) => void,
): string {
  const args = argsText.length > 0 ? splitTopLevelArgs(argsText) : [];
  const attrNames = getAttributeNamesAcrossSchemas(entityType);

  const named: Array<[number, string]> = [];
  for (const [attrName, value] of attributeOverrides ?? []) {
    const index = attrNames.indexOf(attrName);
    if (index >= 0) named.push([index, value]);
  }

  // Grow to the class's FULL declared arity as soon as any override names a
  // declared slot the creation payload never reached. Growing only as far as
  // the edited slot would emit eight arguments for an IfcWall that declares
  // nine: this parser tolerates the truncated record, a schema-validating
  // consumer rejects the file.
  //
  // An index PAST the declared layout is not a slot at all, so it cannot
  // justify growing the record and stays dropped — as does any override on a
  // class neither schema source knows, where there is no arity to grow to.
  let needsPad = named.some(([index]) => index >= args.length);
  if (!needsPad && positionalOverrides) {
    for (const [index] of positionalOverrides) {
      if (index >= args.length && index < attrNames.length) {
        needsPad = true;
        break;
      }
    }
  }
  if (needsPad) {
    while (args.length < attrNames.length) args.push('$');
  }

  // Every `named` index is < attrNames.length by construction, and padding
  // has taken args.length to at least that, so each one lands.
  const realSlots = getRealTypedSlots(entityType, schemaVersion);
  for (const [index, value] of named) {
    const serialized = serializeNamedAttribute(
      entityType,
      index,
      value,
      args[index],
      realSlots,
    );
    // Overlay-created entities take the same rejection: a non-numeric REAL is
    // invalid STEP whoever authored the record. The slot keeps the `$` this
    // path padded it with, rather than gaining a quoted string.
    if (serialized === null) {
      onRejected?.(attrNames[index] ?? `#${index}`, value);
      continue;
    }
    args[index] = serialized;
  }

  if (positionalOverrides && positionalOverrides.size > 0) {
    for (const [index, value] of positionalOverrides) {
      if (index < 0 || index >= args.length) continue;
      args[index] = serializePositionalOverride(
        entityType,
        index,
        value,
        args[index],
        realSlots,
        schemaVersion,
      );
    }
  }

  return args.join(',');
}
