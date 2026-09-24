/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Enum-member reconciliation on schema conversion (#5365).
 *
 * `convertStepLine` renames entities and reconciles attribute counts, but no
 * pass read an enum VALUE: `.TURNSTILE.` (IFC4X3 `IfcDoorTypeEnum`) rode into
 * an IFC4 file and `.LOUVRE.` (IFC4 `IfcAirTerminalTypeEnum`) into IFC2X3,
 * invalid against each file's own header, with no report. This pass reads
 * every enum-typed slot of an already-converted record against the TARGET
 * schema's registry and resolves a member the target does not define by the
 * policy in `schema-enum-policy.ts`. It counts every resolution that loses
 * information, and every refusal.
 *
 * Runs on the converted record, so the target's attribute list applies; a
 * record whose arity is not the target's is left alone, the same guard the
 * required-slot passes use (position `i` need not be attribute `i`).
 */

import { getSchemaRegistryForVersion, type SchemaVersionWithRegistry } from '@ifc-lite/parser';
import { escapeStepString } from './step-serialization.js';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { resolveMissingEnumMember, type EnumPolicyAttribute } from './schema-enum-policy.js';

interface TargetEntity {
  readonly attributes: readonly EnumPolicyAttribute[];
  /** Indices of enum-typed attributes, with the target enum's members. */
  readonly enumSlots: readonly { index: number; members: readonly string[] }[];
}

const TARGETS = new Map<SchemaVersionWithRegistry, ReadonlyMap<string, TargetEntity>>();

function targetEntities(schema: SchemaVersionWithRegistry): ReadonlyMap<string, TargetEntity> {
  let table = TARGETS.get(schema);
  if (table) return table;
  const registry = getSchemaRegistryForVersion(schema);
  const built = new Map<string, TargetEntity>();
  for (const [name, meta] of Object.entries(registry.entities)) {
    const attributes = meta.allAttributes ?? meta.attributes;
    const enumSlots = attributes.flatMap((a, index) => {
      const members = Object.hasOwn(registry.enums, a.type) ? registry.enums[a.type] : undefined;
      return members ? [{ index, members }] : [];
    });
    if (enumSlots.length > 0) built.set(name.toUpperCase(), { attributes, enumSlots });
  }
  table = built;
  TARGETS.set(schema, table);
  return table;
}

const ENUM_TOKEN = /^\s*\.([A-Z0-9_]+)\.\s*$/i;

/** Outcomes that lose the source's meaning, or keep an invalid value. */
type Loss = 'userdefined-label-occupied' | 'notdefined' | 'omit' | 'refuse';

const LOSS_TEXT: Record<Loss, string> = {
  'userdefined-label-occupied': 'written as .USERDEFINED. but the label slot already held a value, so the member name was not kept',
  notdefined: 'written as .NOTDEFINED.',
  omit: 'written as $ (the attribute is optional in the target)',
  refuse: 'KEPT as written, so the file is not valid against its header; the target schema offers no value for it',
};

/** Enum reconciliation for one export: rewrites, and counts what it lost. */
export class EnumReconciliation {
  private readonly losses = new Map<Loss, Map<string, number>>();

  /** Reconcile `line`, already converted to `toSchema`. */
  apply(line: string, toSchema: SchemaVersionWithRegistry): string {
    const open = line.indexOf('(');
    const close = line.lastIndexOf(')');
    const eq = line.indexOf('=');
    if (eq < 0 || open <= eq || close <= open) return line;
    const type = line.slice(eq + 1, open).trim().toUpperCase();
    const entity = targetEntities(toSchema).get(type);
    if (!entity) return line;
    const values = splitTopLevelStepArguments(line.slice(open + 1, close));
    if (values === null || values.length !== entity.attributes.length) return line;
    let changed = false;
    for (const { index, members } of entity.enumSlots) {
      const member = ENUM_TOKEN.exec(values[index])?.[1]?.toUpperCase();
      if (member === undefined || members.includes(member)) continue;
      const resolution = resolveMissingEnumMember(entity.attributes, index, members);
      const where = `${type}.${entity.attributes[index].name} .${member}.`;
      switch (resolution.kind) {
        case 'userdefined':
          values[index] = '.USERDEFINED.';
          if (values[resolution.labelIndex].trim() === '$') values[resolution.labelIndex] = `'${escapeStepString(member)}'`;
          else this.record('userdefined-label-occupied', where);
          changed = true;
          break;
        case 'notdefined':
          values[index] = '.NOTDEFINED.';
          this.record('notdefined', where);
          changed = true;
          break;
        case 'omit':
          values[index] = '$';
          this.record('omit', where);
          changed = true;
          break;
        case 'refuse':
          this.record('refuse', where);
          break;
      }
    }
    return changed ? `${line.slice(0, open + 1)}${values.join(',')}${line.slice(close)}` : line;
  }

  /** One warning per loss kind, naming what it happened to (#5365). */
  warnings(): string[] {
    const out: string[] = [];
    for (const [loss, where] of this.losses) {
      // Every site is named: distinct sites are bounded by the ledger, so none is elided.
      const total = [...where.values()].reduce((a, b) => a + b, 0);
      out.push(`${total} enum value(s) the target schema does not define were ${LOSS_TEXT[loss]}: ${[...where.keys()].join(', ')} (#5365).`);
    }
    return out;
  }

  private record(loss: Loss, where: string): void {
    const bucket = this.losses.get(loss) ?? new Map<string, number>();
    bucket.set(where, (bucket.get(where) ?? 0) + 1);
    this.losses.set(loss, bucket);
  }
}
