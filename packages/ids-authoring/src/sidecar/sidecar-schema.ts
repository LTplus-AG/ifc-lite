/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { validateJson, type JsonSchema, type SchemaError } from '../ops/json-schema-lite.js';
import { VALUE_DEFS } from '../ops/schema-values.js';

const str: JsonSchema = { type: 'string' };
const uuid: JsonSchema = { $ref: '#/$defs/Uuid' };
const arr = (items: JsonSchema): JsonSchema => ({ type: 'array', items });
const record = (values: JsonSchema): JsonSchema => ({ type: 'object', additionalProperties: values });
// Preserve extension fields while validating every field consumed by this core.
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object', properties, required,
});

const provenance: JsonSchema = { oneOf: [
  object({ by: { const: 'user' }, userId: str, at: str, opId: uuid }, ['by', 'at', 'opId']),
  object({ by: { const: 'ai' }, runId: uuid, model: str, at: str, opId: uuid }, ['by', 'runId', 'model', 'at', 'opId']),
  object({
    by: { const: 'import' },
    format: { enum: ['ids', 'xlsx', 'csv', 'yaml', 'bsdd', 'template', 'infer'] },
    ref: str, at: str, opId: uuid,
  }, ['by', 'format', 'at', 'opId']),
] };

const source = object({
  docRef: str, kind: { enum: ['pdf', 'docx', 'xlsx', 'text'] },
  page: { type: 'number' }, para: { type: 'number' }, sheet: str, cell: str, quote: str,
}, ['docRef', 'kind', 'quote']);
const comment = object({ author: str, at: str, text: str }, ['author', 'at', 'text']);
const thread = object({ id: uuid, resolved: { type: 'boolean' }, comments: arr(comment) }, ['id', 'resolved', 'comments']);
const suppression = object({ rule: str, reason: str, by: str, at: str }, ['rule', 'reason', 'at']);

const meta = object({
  provenance: record(arr(provenance)), sources: record(arr(source)), comments: record(arr(thread)),
  suppressions: record(arr(suppression)),
  // Later pitches own these payloads; only their collection shape belongs here.
  tests: record({}), mappings: arr({}), unresolved: arr({}),
  revision: object({
    parentHash: str, label: str,
    signOffs: arr(object({ by: str, at: str, role: str }, ['by', 'at'])),
  }),
  custom: object({
    psets: arr({ $ref: '#/$defs/CustomPsetDecl' }),
    userDefinedTypes: arr(object({ entity: str, value: str }, ['entity', 'value'])),
  }, ['psets', 'userDefinedTypes']),
}, ['provenance', 'sources', 'comments', 'suppressions', 'tests', 'mappings', 'revision', 'unresolved', 'custom']);

const sidecar = object({
  docId: uuid, idsFingerprint: str,
  nodes: object({ document: uuid, specs: arr({ $ref: '#/$defs/SpecNodes' }) }, ['document', 'specs']),
  meta,
}, ['docId', 'idsFingerprint', 'nodes', 'meta']);

/** The op validator's node/UUID definitions also govern imported sidecars (#7168, IDS-025). */
export function validateSidecarShape(value: unknown): SchemaError[] {
  return validateJson(value, sidecar, VALUE_DEFS);
}
