/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `ops` input of `ids_apply_ops` as advertised in `tools/list`.
 *
 * The full op schema (`getOpJsonSchema()`, ~41 KB of `oneOf` over `$defs`) was
 * 39% of every schema byte in `tools/list`. It is published once as the
 * resource `IDS_OPS_SCHEMA_URI`; the tool advertises a discriminated list
 * (`kind` enum, `opId`, `payload` object) plus a field summary per kind that is
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

/** `spec.add: specId, name, ifcVersions [index, description, …]` */
function kindLine(kind: string, defs: Defs): string {
  const payload = payloadOf(kind, defs);
  const fields = Object.keys(payload.properties ?? {});
  const required = payload.required ?? [];
  const optional = fields.filter((f) => !required.includes(f));
  return `${kind}: ${required.join(', ') || '(none)'}${optional.length ? ` [${optional.join(', ')}]` : ''}`;
}

/** One branch of a discriminated union: `{type:"entity", name, [predefinedType]}`. */
function branchShape(schema: JsonSchema): string {
  const props = schema.properties ?? {};
  const required = schema.required ?? [];
  const parts = Object.entries(props).map(([key, sub]) => {
    if (sub.const !== undefined) return `${key}:${JSON.stringify(sub.const)}`;
    return required.includes(key) ? key : `[${key}]`;
  });
  return `{${parts.join(', ')}}`;
}

function fail(message: string): never {
  throw new Error(`ids ops schema: ${message}`);
}

/** `$defs` names a schema refers to at its own level: a property, an array item or a union branch. */
function directRefs(schema: JsonSchema): string[] {
  const subs = [...Object.values(schema.properties ?? {}), ...(Array.isArray(schema.oneOf) ? schema.oneOf as JsonSchema[] : [])];
  return subs.flatMap((sub) => [refName(sub), refName(sub.items)]).filter((n): n is string => n !== undefined);
}

/**
 * Every type a payload field names, and the types those name in turn, so an
 * agent that does not read resources still sees each shape. Uuid is covered
 * by the closing line.
 */
function legendNames(defs: Defs): string[] {
  const seen = new Set<string>(['Uuid']);
  const queue = OP_KINDS.flatMap((kind) => directRefs(payloadOf(kind, defs)));
  const out: string[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const def = defs[name] ?? fail(`no $def ${name}`);
    out.push(name);
    const branches = Array.isArray(def.oneOf) ? (def.oneOf as JsonSchema[]).map((b) => defs[refName(b) ?? ''] ?? b) : [def];
    queue.push(...branches.flatMap(directRefs));
  }
  return out;
}

function legendLine(name: string, defs: Defs): string {
  const def = defs[name];
  if (Array.isArray(def.enum)) return `${name} = ${def.enum.map((v) => JSON.stringify(v)).join(' | ')}`;
  if (Array.isArray(def.oneOf)) {
    return `${name} = ${(def.oneOf as JsonSchema[]).map((b) => {
      const target = refName(b);
      return target ? (defs[target]?.properties ? branchShape(defs[target]) : target) : branchShape(b);
    }).join(' | ')}`;
  }
  if (def.properties) return `${name} = ${branchShape(def)}`;
  if (def.type === 'array') return `${name} = [${refName(def.items) ?? String(def.items?.type ?? 'any')}]`;
  return `${name} = ${Array.isArray(def.type) ? def.type.join('|') : String(def.type ?? 'any')}`;
}

function payloadDescription(defs: Defs): string {
  return [
    'Fields by kind (required, then [optional]):',
    ...OP_KINDS.map((kind) => kindLine(kind, defs)),
    'Types:',
    ...legendNames(defs).map((name) => legendLine(name, defs)),
    `Ids (specId, facetId, opId, ...) are lowercase UUIDs. Full schema: resource ${IDS_OPS_SCHEMA_URI}.`,
  ].join('\n');
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
