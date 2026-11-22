/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `.USERDEFINED.` rule of a PredefinedType (#10780): IFC4's
 * `CorrectPredefinedType` (and many IFC2X3 WHERE rules) allow `.USERDEFINED.`
 * only with the entity's label attribute set. A converted record that breaks
 * it is reported, not repaired: the converter does not invent a label.
 * Every non-abstract entity with both attributes has the rule except the
 * {@link EXEMPT_AT} ones. Twin of Rust `schema_userdefined.rs`; both are held
 * to `rust/export/tests/fixtures/schema_userdefined_rules.json`.
 */

import type { SchemaVersionWithRegistry } from '@ifc-lite/parser';
import { attrNameTable } from './schema-converter.js';
import { LABEL_CARRIES } from './schema-enum-policy.js';
import { isToken, isUnset } from './schema-converter-userdefined-label.js';

const LABELS: readonly string[] = ['ObjectType', 'ElementType', 'ProcessType', 'ResourceType'];

/**
 * The entities with both attributes but no USERDEFINED rule, per schema, as
 * base-36 positions in that schema's {@link candidates} (every registry entity
 * with both attributes, abstract ones included). The viewer loads this module
 * eagerly, and the names would cost about 1.8 KB (#10780 perf ratchet); the
 * Rust twin keeps the names. The test checks every candidate against the
 * shared fixture's names and prints the encoding to paste here when a
 * registry change moves a position.
 */
const EXEMPT_AT: Readonly<Record<SchemaVersionWithRegistry, string>> = {
  IFC2X3: '0 4 5 7 9 a d g j l m o s t u v w x 13 14 1a 1b 1c 1d 1e 1g 1k 1l 1m 1n 1q 1r 1s 1t 1v 1x 1y 1z 20 21 22 23 24 25 26 29 2a 2f 2g',
  IFC4: '0 m 1o 1p 22 23 24 25 26 30 3j 3q 49 4a 4d 4e 4q 4r 7b 7c',
  IFC4X3: '0 b c 1x 1y 2g 3g 41 4a 59 5a 5m 63',
};

/** True for an attribute list with PredefinedType and a label attribute. */
const candidate = (names: readonly string[]) => names.includes('PredefinedType') && names.some((a) => LABELS.includes(a));

/** The entity names of `schema` that are {@link candidate}s, sorted. */
function candidates(schema: SchemaVersionWithRegistry): string[] {
  return [...(attrNameTable(schema) ?? [])].filter(([, n]) => candidate(n)).map(([t]) => t).sort();
}

const EXEMPT_SETS = new Map<SchemaVersionWithRegistry, ReadonlySet<string>>();

function exempt(schema: SchemaVersionWithRegistry): ReadonlySet<string> {
  let set = EXEMPT_SETS.get(schema);
  if (!set) {
    const names = candidates(schema);
    set = new Set(EXEMPT_AT[schema].split(' ').map((at) => names[parseInt(at, 36)]));
    EXEMPT_SETS.set(schema, set);
  }
  return set;
}

/** `[enum index, label index]` when `entityType` has the rule in `schema`. */
export function userDefinedRule(schema: SchemaVersionWithRegistry, entityType: string): readonly [number, number] | undefined {
  const names = attrNameTable(schema)?.get(entityType);
  if (!names) return undefined;
  const pair = schema === 'IFC2X3' ? LABEL_CARRIES.find(([type]) => type === entityType) : undefined;
  if (pair) {
    const enumIndex = names.indexOf(pair[2]);
    const labelIndex = names.indexOf(pair[3]);
    return enumIndex >= 0 && labelIndex >= 0 ? [enumIndex, labelIndex] : undefined;
  }
  if (!candidate(names) || exempt(schema).has(entityType)) return undefined;
  return [names.indexOf('PredefinedType'), names.findIndex((n) => LABELS.includes(n))];
}

/** True when converted `args` under `rule` say `.USERDEFINED.` and leave the label unset. */
export function breaksUserDefinedRule(args: readonly string[], [predefined, label]: readonly [number, number]): boolean {
  return args.length > Math.max(predefined, label)
    && isToken(args[predefined], '.USERDEFINED.')
    && isUnset(args[label]);
}
