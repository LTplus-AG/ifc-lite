/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `entity_create`: the MCP surface's one STEP-level creator.
 *
 * `global_id` is the MCP spelling of the `GlobalId` every in-store builder and
 * `bim.store.add*` accept (#5167 Phase 2): a caller that re-runs the same
 * authoring step can pin the identity instead of minting a fresh one each run.
 * It is validated with the encoder's own rule (`isValidIfcGuid`) and written
 * to positional slot 0, which is where `GlobalId` sits on every `IfcRoot`
 * subtype. Two refusals, both `INVALID_INPUT`, both before the editor exists
 * so a refused call leaves the session untouched:
 *
 *   - the class has no GlobalId (not an `IfcRoot` subtype), or `attributes[0]`
 *     already names a different one: silently overwriting either would author
 *     something the caller did not ask for;
 *   - the GlobalId is already carried by an entity in the effective model
 *     (parsed or created this session). The store editor does not check this
 *     itself, and a duplicate GlobalId corrupts every GlobalId-keyed lookup.
 */

import { isValidIfcGuid } from '@ifc-lite/encoding';
import { getInheritanceChainAcrossSchemas, normalizeIfcTypeName } from '@ifc-lite/parser';
import type { Tool } from './types.js';
import { findByGlobalId, okResult, resolveModel } from './util.js';
import { stepText } from '../overlay.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';

function invalid(message: string, details: Record<string, unknown>): ToolExecutionError {
  return new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message, details });
}

/** Positional attributes with the requested GlobalId in slot 0, or a refusal. */
function withGlobalId(
  m: ReturnType<typeof resolveModel>,
  type: string,
  attrs: unknown[],
  globalId: string,
): unknown[] {
  if (!isValidIfcGuid(globalId)) {
    throw invalid(
      `global_id "${globalId}" is not a valid IFC GlobalId (22 characters of the IFC base64 alphabet, first character 0-3).`,
      { globalId },
    );
  }
  if (!getInheritanceChainAcrossSchemas(normalizeIfcTypeName(type)).includes('IfcRoot')) {
    throw invalid(`${type} is not an IfcRoot subtype, so it has no GlobalId; omit global_id.`, { type, globalId });
  }
  const positional = attrs.length > 0 ? stepText(attrs[0]) : undefined;
  if (positional !== undefined && positional !== globalId) {
    throw invalid(
      `global_id "${globalId}" conflicts with attributes[0] "${positional}"; give the GlobalId once.`,
      { globalId, positional },
    );
  }
  const holder = findByGlobalId(m, globalId);
  if (holder !== null) {
    throw invalid(
      `GlobalId "${globalId}" is already used by #${holder} in model '${m.id}'; GlobalIds must be unique.`,
      { globalId, expressId: holder, modelId: m.id },
    );
  }
  const out = [...attrs];
  out[0] = globalId;
  return out;
}

export const entityCreate: Tool = {
  name: 'entity_create',
  description:
    'Create a new IFC entity with raw positional attributes. Returns the new expressId. ' +
    'Optional `global_id` sets the GlobalId of an IfcRoot subtype (attribute 0); it must be a valid ' +
    '22-character IFC GUID not already used in the model.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      type: { type: 'string', description: 'IFC entity name, e.g. IfcWall.' },
      attributes: {
        type: 'array',
        description: 'Positional STEP attributes (strings, numbers, booleans, or refs of form "#42").',
        items: {},
      },
      global_id: {
        type: 'string',
        minLength: 22,
        maxLength: 22,
        description:
          'GlobalId for the new entity (IfcRoot subtypes only), written to attribute 0. ' +
          'A 22-character IFC GUID; refused if invalid or already used in the model.',
      },
    },
    required: ['type'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const type = input.type as string;
    let attrs = (input.attributes as unknown[] | undefined) ?? [];
    const globalId = input.global_id as string | undefined;
    if (globalId !== undefined) attrs = withGlobalId(m, type, attrs, globalId);
    const editor = m.backend.ensureEditor();
    const ref = editor.addEntity(type, attrs as Parameters<typeof editor.addEntity>[1]);
    return okResult(`Created ${type} as #${ref.expressId}.`, {
      expressId: ref.expressId,
      type,
      ...(globalId !== undefined ? { globalId } : {}),
    });
  },
};
