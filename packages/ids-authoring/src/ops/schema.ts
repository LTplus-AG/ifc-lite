/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The op contract as JSON Schema — the single source the runtime validator
 * (`validateOp`) interprets and `getOpJsonSchema()` hands to AI tools, MCP
 * and other non-TypeScript callers (§8: the agent's contract cannot drift
 * from the reducer because both read this object).
 */

import { validateJson, type JsonSchema, type SchemaError } from './json-schema-lite.js';
import { obj, VALUE_DEFS } from './schema-values.js';
import { OPS_VERSION, type OpKind, type StudioOp } from './types.js';

const ref = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });
const str: JsonSchema = { type: 'string' };
const nonEmpty: JsonSchema = { type: 'string', minLength: 1 };
const nullableStr: JsonSchema = { type: ['string', 'null'] };
const index: JsonSchema = { type: 'integer', minimum: 0 };
const uuid = ref('Uuid');
const versions: JsonSchema = { type: 'array', items: ref('IfcVersion'), minItems: 1 };
const scope: JsonSchema = { type: 'array', items: uuid };

const PAYLOADS: Record<OpKind, JsonSchema> = {
  'doc.setInfo': obj(
    {
      field: { enum: ['title', 'copyright', 'version', 'description', 'author', 'date', 'purpose', 'milestone'] },
      value: nullableStr,
    },
    ['field', 'value'],
  ),
  'spec.add': obj(
    {
      specId: uuid,
      index,
      name: str,
      ifcVersions: versions,
      description: str,
      instructions: str,
      identifier: str,
      cardinality: ref('Optionality'),
    },
    ['specId', 'name', 'ifcVersions'],
  ),
  'spec.remove': obj({ specId: uuid }, ['specId']),
  'spec.duplicate': obj({ specId: uuid, newSpecId: uuid, nameSuffix: str }, ['specId', 'newSpecId']),
  'spec.move': obj({ specId: uuid, toIndex: index }, ['specId', 'toIndex']),
  'spec.set': obj(
    { specId: uuid, field: { enum: ['name', 'description', 'instructions', 'identifier'] }, value: nullableStr },
    ['specId', 'field', 'value'],
  ),
  'spec.setCardinality': obj({ specId: uuid, cardinality: ref('Optionality') }, ['specId', 'cardinality']),
  'spec.setIfcVersions': obj({ specId: uuid, versions }, ['specId', 'versions']),
  'spec.restore': obj({ index, spec: ref('IDSSpecification'), nodes: ref('SpecNodes') }, ['index', 'spec', 'nodes']),
  'spec.patch': obj(
    {
      specId: uuid,
      set: obj({
        name: str,
        description: nullableStr,
        instructions: nullableStr,
        identifier: nullableStr,
        ifcVersions: { type: 'array', items: ref('IfcVersion') },
        ifcVersionRaw: nullableStr,
        minOccurs: { type: ['number', 'null'] },
        maxOccurs: { anyOf: [{ type: ['number', 'null'] }, { const: 'unbounded' }] },
        applicabilityCardinality: nullableStr,
      }),
    },
    ['specId', 'set'],
  ),
  'facet.add': obj(
    {
      specId: uuid,
      section: ref('Section'),
      facetId: uuid,
      index,
      facet: ref('FacetDraft'),
      optionality: ref('Optionality'),
      description: str,
      instructions: str,
      constraintIds: ref('ConstraintIds'),
    },
    ['specId', 'section', 'facetId', 'facet'],
  ),
  'facet.remove': obj({ facetId: uuid }, ['facetId']),
  'facet.move': obj({ facetId: uuid, toSpecId: uuid, toSection: ref('Section'), toIndex: index }, [
    'facetId',
    'toIndex',
  ]),
  'facet.replace': obj({ facetId: uuid, facet: ref('FacetDraft'), constraintIds: ref('ConstraintIds') }, [
    'facetId',
    'facet',
  ]),
  'facet.setField': obj(
    { facetId: uuid, field: ref('FacetField'), value: { anyOf: [ref('ValueInput'), { type: 'null' }] }, constraintId: uuid },
    ['facetId', 'field', 'value'],
  ),
  'facet.setRelation': obj({ facetId: uuid, relation: ref('PartOfRelation') }, ['facetId', 'relation']),
  'facet.restore': obj(
    {
      specId: uuid,
      section: ref('Section'),
      index,
      facet: ref('IDSFacet'),
      requirement: obj(
        { optionality: ref('Optionality'), cardinalityRaw: str, description: str, instructions: str },
        ['optionality'],
      ),
      nodes: ref('FacetNodes'),
    },
    ['specId', 'section', 'index', 'facet', 'nodes'],
  ),
  'facet.patch': obj(
    {
      facetId: uuid,
      set: obj({
        optionality: ref('Optionality'),
        cardinalityRaw: nullableStr,
        description: nullableStr,
        instructions: nullableStr,
        relation: ref('PartOfRelation'),
        rawRelation: nullableStr,
      }),
    },
    ['facetId', 'set'],
  ),
  'requirement.setOptionality': obj({ facetId: uuid, optionality: ref('Optionality') }, ['facetId', 'optionality']),
  'requirement.set': obj(
    { facetId: uuid, field: { enum: ['description', 'instructions'] }, value: nullableStr },
    ['facetId', 'field', 'value'],
  ),
  'value.set': obj({ facetId: uuid, field: ref('FacetField'), value: ref('ValueInput'), constraintId: uuid }, [
    'facetId',
    'field',
    'value',
  ]),
  'value.addEnumValue': obj({ facetId: uuid, field: ref('FacetField'), value: ref('Scalar'), constraintId: uuid }, [
    'facetId',
    'field',
    'value',
  ]),
  'value.removeEnumValue': obj({ facetId: uuid, field: ref('FacetField'), value: ref('Scalar') }, [
    'facetId',
    'field',
    'value',
  ]),
  'meta.custom.declarePset': obj({ decl: ref('CustomPsetDecl'), index }, ['decl']),
  'meta.custom.removePset': obj({ name: nonEmpty }, ['name']),
  'meta.custom.declareUserDefinedType': obj({ entity: nonEmpty, value: nonEmpty, index }, ['entity', 'value']),
  'meta.custom.removeUserDefinedType': obj({ entity: nonEmpty, value: nonEmpty }, ['entity', 'value']),
  'meta.comment.add': obj({ nodeId: uuid, threadId: uuid, author: nonEmpty, at: nonEmpty, text: nonEmpty }, [
    'nodeId',
    'threadId',
    'author',
    'at',
    'text',
  ]),
  'meta.comment.reply': obj({ threadId: uuid, author: nonEmpty, at: nonEmpty, text: nonEmpty }, ['threadId', 'author', 'at', 'text']),
  'meta.comment.removeReply': obj({ threadId: uuid }, ['threadId']),
  'meta.comment.resolve': obj({ threadId: uuid, resolved: { type: 'boolean' } }, ['threadId', 'resolved']),
  'meta.comment.removeThread': obj({ threadId: uuid }, ['threadId']),
  'meta.comment.restoreThread': obj({ nodeId: uuid, index, thread: ref('CommentThread') }, ['nodeId', 'index', 'thread']),
  'bulk.renameProperty': obj(
    { fromPset: nonEmpty, fromName: nonEmpty, toPset: nonEmpty, toName: nonEmpty, scope },
    ['fromPset', 'fromName', 'toPset', 'toName'],
  ),
  'bulk.retargetEntity': obj({ from: nonEmpty, to: nonEmpty, scope }, ['from', 'to']),
  'bulk.applyTemplate': obj(
    { template: ref('OpTemplate'), params: { type: 'object', additionalProperties: str } },
    ['template', 'params'],
  ),
};

/** Every op kind of vocabulary v1, in schema order. */
export const OP_KINDS = Object.keys(PAYLOADS) as OpKind[];

const COMPOUND = new Set<string>(['bulk.renameProperty', 'bulk.retargetEntity', 'bulk.applyTemplate']);

function opDefName(kind: string): string {
  return `Op_${kind.replace(/\./g, '_')}`;
}

function buildDefs(): Record<string, JsonSchema> {
  const defs: Record<string, JsonSchema> = { ...VALUE_DEFS };
  defs.ConstraintIds = VALUE_DEFS.FacetNodes.properties?.constraints ?? {};
  for (const kind of OP_KINDS) {
    defs[opDefName(kind)] = obj({ kind: { const: kind }, opId: uuid, payload: PAYLOADS[kind] }, [
      'kind',
      'opId',
      'payload',
    ]);
  }
  defs.TemplateOp = {
    type: 'object',
    properties: {
      kind: { enum: OP_KINDS.filter((k) => !COMPOUND.has(k)) },
      payload: { type: 'object' },
    },
    required: ['kind', 'payload'],
    additionalProperties: false,
  };
  defs.OpTemplate = obj(
    {
      id: nonEmpty,
      title: str,
      params: {
        type: 'array',
        items: obj({ name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }, description: str, default: str }, [
          'name',
        ]),
      },
      ops: { type: 'array', items: ref('TemplateOp'), minItems: 1 },
    },
    ['id', 'params', 'ops'],
  );
  defs.StudioOp = { oneOf: OP_KINDS.map((k) => ref(opDefName(k))) };
  return defs;
}

const DEFS = buildDefs();

/**
 * The JSON Schema (2020-12) of one op of vocabulary v1. Self-contained
 * (`$defs` included); safe to embed in an AI tool definition.
 */
export function getOpJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://ifclite.dev/schemas/ids-authoring/ops-v${OPS_VERSION}.json`,
    title: `IDS Studio operation (opsVersion ${OPS_VERSION})`,
    ...structuredClone(DEFS.StudioOp),
    $defs: structuredClone(DEFS),
  };
}

export type OpValidation = { ok: true; op: StudioOp } | { ok: false; errors: SchemaError[] };

/** Runtime check of an untrusted value against the op schema. */
export function validateOp(value: unknown): OpValidation {
  const errors = validateJson(value, DEFS.StudioOp, DEFS);
  return errors.length === 0 ? { ok: true, op: value as StudioOp } : { ok: false, errors };
}

/** Validate an arbitrary named `$def` (used for template expansion). */
export function validateAgainstDef(value: unknown, def: string): SchemaError[] {
  return validateJson(value, ref(def), DEFS);
}
