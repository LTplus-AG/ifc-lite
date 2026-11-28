/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `ops` input of `ids_apply_ops` as advertised in `tools/list`.
 *
 * The full op schema (`getOpJsonSchema()`, ~41 KB of `oneOf` over `$defs`) was
 * 39% of every schema byte in `tools/list`. It is published once as the
 * resource `IDS_OPS_SCHEMA_URI`; the tool advertises a discriminated list
 * (`kind` enum, `opId`, `payload` object) plus a sample field summary that is
 * generated from the same `$defs`, so it cannot drift from the real contract.
 * The handler still checks every op against the full schema (`validateOp`
 * inside `applyOpsGated`) before anything is applied.
 */

import { getOpJsonSchema, OP_KINDS } from '@ifc-lite/ids-authoring';
import type { JsonSchema } from '../protocol/index.js';

export const IDS_OPS_SCHEMA_URI = 'ifc-lite://schemas/ids-ops-v1.json';

type Defs = Record<string, JsonSchema>;

function refName(schema: JsonSchema | undefined): string | undefined {
  const ref = schema?.$ref;
  return typeof ref === 'string' ? ref.slice(ref.lastIndexOf('/') + 1) : undefined;
}

function payloadOf(kind: string, defs: Defs): JsonSchema {
  return defs[`Op_${kind.replace(/\./g, '_')}`]?.properties?.payload ?? fail(`no payload for ${kind}`);
}

/** A field with its type: `facet:FacetDraft`, `ifcVersions:[IfcVersion]`, `field:"title"|"date"`, `set:{name, [description]}`. Plain fields and ids stay bare. */
function typedField(name: string, schema: JsonSchema | undefined): string {
  const type = schema ? typeOf(schema) : undefined;
  return type ? `${name}:${type}` : name;
}

function branchesOf(schema: JsonSchema): JsonSchema[] {
  return ([schema.oneOf, schema.anyOf].find(Array.isArray) ?? []) as JsonSchema[];
}

function plainType(schema: JsonSchema): string {
  return Array.isArray(schema.type) ? schema.type.join('|') : String(schema.type ?? 'any');
}

function enumText(values: readonly unknown[], separator: string): string {
  return values.map((v) => JSON.stringify(v)).join(separator);
}

function typeOf(schema: JsonSchema): string | undefined {
  const ref = refName(schema);
  if (ref) return ref === 'Uuid' ? undefined : ref;
  // Arrays always show as arrays, so a list of ids is not mistaken for one id.
  if (schema.items) return `[${refName(schema.items) ?? typeOf(schema.items) ?? plainType(schema.items)}]`;
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  // A long enum (the op kinds again, inside templates) would cost more than it tells.
  if (Array.isArray(schema.enum)) return schema.enum.length > 12 ? `string (${schema.enum.length} allowed values)` : enumText(schema.enum, '|');
  if (schema.properties) return branchShape(schema);
  const branches = branchesOf(schema);
  if (branches.length > 0) return branches.map((b) => typeOf(b) ?? plainType(b)).join('|');
  // Strings stay bare (most fields are names or text); other scalars say what they are.
  return schema.type !== undefined && schema.type !== 'string' ? plainType(schema) : undefined;
}

/** `spec.add: specId, name, ifcVersions:[IfcVersion] [index, description, …]` */
function kindLine(kind: string, defs: Defs): string {
  const payload = payloadOf(kind, defs);
  const props = payload.properties ?? {};
  const required = payload.required ?? [];
  const show = (names: string[]) => names.map((n) => typedField(n, props[n])).join(', ');
  const optional = Object.keys(props).filter((f) => !required.includes(f));
  return `${kind}: ${show(required) || '(none)'}${optional.length ? ` [${show(optional)}]` : ''}`;
}

/** One branch of a discriminated union: `{type:"entity", name:ValueInput, [predefinedType:ValueInput]}`. */
function branchShape(schema: JsonSchema): string {
  const props = schema.properties ?? {};
  const required = schema.required ?? [];
  const parts = Object.entries(props).map(([key, sub]) => {
    const field = typedField(key, sub);
    return required.includes(key) || sub.const !== undefined ? field : `[${field}]`;
  });
  return `{${parts.join(', ')}}`;
}

function fail(message: string): never {
  throw new Error(`ids ops schema: ${message}`);
}

function payloadDescription(defs: Defs): string {
  return `Example fields by kind: ${kindLine('facet.add', defs)}. Read ${IDS_OPS_SCHEMA_URI} for all payload shapes and required fields.`;
}

export function idsOpsInputSchema(): JsonSchema {
  const defs = getOpJsonSchema().$defs as Defs;
  return {
    type: 'array',
    minItems: 1,
    description: `IDS ops (vocabulary v1), applied in order as one batch. Each op is {kind, opId, payload}; read ${IDS_OPS_SCHEMA_URI} for every payload type.`,
    items: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...OP_KINDS], description: 'Operation kind.' },
        opId: { ...defs.Uuid, description: 'A fresh lowercase UUID for this op.' },
        payload: { type: 'object', description: payloadDescription(defs) },
      },
      required: ['kind', 'opId', 'payload'],
      additionalProperties: false,
    },
  };
}
