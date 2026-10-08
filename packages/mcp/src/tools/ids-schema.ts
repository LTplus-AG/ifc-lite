/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Grounding lookups for IDS authoring agents (IDS-118):
 * `ids_schema_search`, `ids_schema_entity`, `ids_schema_pset`. They read
 * the same schema tables as the grounding gate in `ids_apply_ops`, so a
 * name found here passes the gate.
 */

import type { IFCVersion } from '@ifc-lite/ids';
import { createGateContext, describeEntity, describePset, searchSchema, type SchemaKind } from '@ifc-lite/ids-authoring';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import type { Tool } from './types.js';
import { okResult } from './util.js';

const VERSION = {
  type: 'string',
  enum: ['IFC2X3', 'IFC4', 'IFC4X3', 'IFC4X3_ADD2'],
  default: 'IFC4',
  description: 'IFC schema version of the specification.',
} as const;

const idsSchemaSearch: Tool = {
  name: 'ids_schema_search',
  description: 'Find IFC entity, property set, property or data type names close to a query (typo-tolerant). Use before writing a name into an IDS facet.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1 },
      kind: { type: 'string', enum: ['entity', 'pset', 'property', 'dataType'], description: 'Restrict to one kind.' },
      ifc_version: VERSION,
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async handler(input) {
    const hits = searchSchema(await createGateContext(), input.query as string, {
      kind: input.kind as SchemaKind | undefined,
      version: input.ifc_version as IFCVersion,
      limit: input.limit as number,
    });
    const top = hits.slice(0, 5).map((h) => `${h.value} (${h.kind})`).join(', ');
    return okResult(hits.length ? `Closest: ${top}.` : 'No close names.', { hits });
  },
};

const idsSchemaEntity: Tool = {
  name: 'ids_schema_entity',
  description: 'Describe an IFC entity for IDS authoring: supertypes, abstract flag, predefined types, attributes and the standard property sets that apply to it.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1, description: 'Entity name, any case (IfcDoor or IFCDOOR).' }, ifc_version: VERSION },
    required: ['name'],
    additionalProperties: false,
  },
  async handler(input) {
    const ctx = await createGateContext();
    const version = input.ifc_version as IFCVersion;
    const name = input.name as string;
    const entity = describeEntity(ctx, name, version);
    if (!entity) {
      const candidates = searchSchema(ctx, name, { kind: 'entity', version, limit: 5 });
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `"${name}" is not an entity of ${version}.${candidates.length ? ` Did you mean: ${candidates.map((c) => c.value).join(', ')}?` : ''}`,
        details: { candidates },
      });
    }
    return okResult(`${entity.name} (${version}): ${entity.propertySets.length} applicable property set(s).`, { entity });
  },
};

const idsSchemaPset: Tool = {
  name: 'ids_schema_pset',
  description: 'Describe a standard property or quantity set: the entities it applies to and its properties with data types and enumerations.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1, description: 'Exact set name, e.g. Pset_DoorCommon.' }, ifc_version: VERSION },
    required: ['name'],
    additionalProperties: false,
  },
  async handler(input) {
    const ctx = await createGateContext();
    const version = input.ifc_version as IFCVersion;
    const name = input.name as string;
    const pset = describePset(ctx, name, version);
    if (!pset) {
      const candidates = searchSchema(ctx, name, { kind: 'pset', version, limit: 5 });
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `"${name}" is not a standard property set of ${version}.${candidates.length ? ` Did you mean: ${candidates.map((c) => c.value).join(', ')}?` : ''}`,
        details: { candidates },
      });
    }
    return okResult(`${pset.name} (${version}): ${pset.properties.length} propert${pset.properties.length === 1 ? 'y' : 'ies'}.`, { pset });
  },
};

export const idsSchemaTools: Tool[] = [idsSchemaSearch, idsSchemaEntity, idsSchemaPset];
