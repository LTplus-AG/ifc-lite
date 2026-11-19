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
import { skipStepTrivia } from './step-slot-grammar.js';

const LABELS: readonly string[] = ['ObjectType', 'ElementType', 'ProcessType', 'ResourceType'];

/**
 * The entities with both attributes but no USERDEFINED rule, per schema, as
 * base-36 positions in that schema's {@link candidates}: the viewer loads this
 * module eagerly, and the names would cost about 1.8 KB (#10780 perf ratchet).
 * The test checks every candidate against the shared fixture's names, so a
 * registry change that moves a position fails it.
 */
const EXEMPT_AT: Readonly<Record<SchemaVersionWithRegistry, string>> = {
  IFC2X3: '0 4 5 7 9 a d g j l m o s t u v w x 13 14 1a 1b 1c 1d 1e 1g 1k 1l 1m 1n 1q 1r 1s 1t 1v 1x 1y 1z 20 21 22 23 24 25 26 29 2a 2f 2g',
  IFC4: '0 m 1o 1p 22 23 24 25 26 30 3j 3q 49 4a 4d 4e 4q 4r 7b 7c',
  IFC4X3: '0 b c 1x 1y 2g 3g 41 4a 59 5a 5m 63',
};

/** The entity names of `schema` with PredefinedType and a label attribute, sorted. */
function candidates(schema: SchemaVersionWithRegistry): string[] {
  const table = attrNameTable(schema) ?? new Map<string, readonly string[]>();
  return [...table].filter(([, n]) => n.includes('PredefinedType') && n.some((a) => LABELS.includes(a))).map(([t]) => t).sort();
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

/** `[PredefinedType index, label index]` when `entityType` has the rule in `schema`. */
export function userDefinedRule(schema: SchemaVersionWithRegistry, entityType: string): readonly [number, number] | undefined {
  const names = attrNameTable(schema)?.get(entityType);
  const predefined = names?.indexOf('PredefinedType') ?? -1;
  const label = names?.findIndex((n) => LABELS.includes(n)) ?? -1;
  if (predefined < 0 || label < 0 || exempt(schema).has(entityType)) return undefined;
  return [predefined, label];
}

/** True when converted `args` under `rule` say `.USERDEFINED.` and leave the label unset. */
export function breaksUserDefinedRule(args: readonly string[], [predefined, label]: readonly [number, number]): boolean {
  return args.length > Math.max(predefined, label)
    && isToken(args[predefined], '.USERDEFINED.')
    && isToken(args[label], '$');
}

/** True when `slot` is `token` (any case) with only whitespace and comments around it. */
function isToken(slot: string, token: string): boolean {
  const start = skipStepTrivia(slot, 0);
  return start !== -1 && slot.slice(start, start + token.length).toUpperCase() === token
    && skipStepTrivia(slot, start + token.length) === slot.length;
}
