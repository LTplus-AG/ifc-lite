/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { constants as bufferConstants } from 'node:buffer';
import { parseStep, selectSubsetSeeds, SubsetSelectionError } from '@ifc-lite/export';
import type { BimContext, ComparisonOp } from '@ifc-lite/sdk';
import type { LoadedModel } from '../context.js';
import { withIfcBytes } from './export-source.js';
import { refuseSourceIdsWhilePending } from './transform-schema.js';
import type { JsonSchema } from '../protocol/types.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';

const operators: ComparisonOp[] = ['=', '!=', '>', '<', '>=', '<=', 'contains', 'exists', 'matches'];

export const exportFilterProperties = {
  type: { type: 'string', pattern: '\\S', description: 'IFC type, e.g. IfcWall.' },
  storey: { type: 'string', minLength: 1, description: 'Storey name or express ID.' },
  where: {
    type: 'object',
    properties: {
      set: { type: 'string', description: 'Property or quantity set.' },
      property: { type: 'string' },
      operator: { type: 'string', enum: operators },
      value: { type: 'string', description: 'Omit for exists.' },
    },
    required: ['set', 'property', 'operator'],
    additionalProperties: false,
  },
  limit: { type: 'integer', minimum: 1, description: 'Maximum matches.' },
} satisfies Record<string, JsonSchema>;

export function hasExportFilter(input: Record<string, unknown>): boolean {
  return input.type !== undefined || !!(input.where || input.limit) || input.storey != null;
}

const storeyExpressId = /^#?\d+$/;

export function checkStoreyBeforeBaking(model: LoadedModel, input: Record<string, unknown>): void {
  if (typeof input.storey === 'string' && storeyExpressId.test(input.storey.trim())) {
    refuseSourceIdsWhilePending(model, 'A storey given as a number');
  }
}

function resolveStorey(bim: BimContext, selector: string) {
  const storey = selector.trim();
  if (!storey) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Storey must not be blank.' });
  const storeys = bim.storeys();
  const id = storeyExpressId.test(storey) ? Number(storey.replace(/^#/, '')) : undefined;
  const named = storeys.filter((entry) => entry.name.toLowerCase() === storey.toLowerCase());
  const matches = named.length > 0 ? named
    : storeys.filter((entry) => entry.name.toLowerCase().includes(storey.toLowerCase()));
  const exactId = id === undefined ? undefined : storeys.find((entry) => entry.ref.expressId === id);
  if (!exactId && matches.length > 1) {
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: `Storey "${storey}" matches several storeys. Use an exact name or express ID.` });
  }
  const match = exactId ?? matches[0];
  if (!match) {
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: `Storey "${storey}" not found.` });
  }
  return match;
}

function storeyMembership(storey: ReturnType<typeof resolveStorey>, bytes: Uint8Array, baked: boolean) {
  if (bytes.byteLength >= bufferConstants.MAX_STRING_LENGTH) {
    throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: 'The model is too large to select a storey from its STEP records.' });
  }
  const parsed = parseStep(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1'));
  // The live query and a baked STEP snapshot can have different express IDs.
  const storeyId = baked ? parsed.guidToId.get(storey.globalId) : storey.ref.expressId;
  if (storeyId === undefined) {
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'The selected storey is missing from the serialized model.' });
  }
  let memberIds: Set<number>;
  try {
    memberIds = selectSubsetSeeds(parsed, { storeys: [`#${storeyId}`] });
  } catch (error) {
    if (!(error instanceof SubsetSelectionError)) throw error;
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: error.message });
  }
  memberIds.delete(storeyId);
  if (!baked) return (entity: ReturnType<typeof resolveStorey>) => memberIds.has(entity.ref.expressId);
  const globalIds = new Set<string>();
  for (const [globalId, id] of parsed.guidToId) {
    if (memberIds.has(id)) globalIds.add(globalId);
  }
  return (entity: ReturnType<typeof resolveStorey>) => globalIds.has(entity.globalId);
}

export async function selectExportEntities(model: LoadedModel, input: Record<string, unknown>, bytes?: Uint8Array) {
  let query = model.bim.query();
  if (input.type !== undefined) {
    if (typeof input.type !== 'string' || !input.type.trim()) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'IFC type must not be blank.' });
    }
    query = query.byType(input.type);
  }
  if (input.where) {
    const { set, property, operator, value } = input.where as {
      set: string;
      property: string;
      operator: ComparisonOp;
      value?: string;
    };
    if (operator !== 'exists' && value === undefined) {
      throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'where.value is required for this operator.' });
    }
    query = query.where(set, property, operator, value);
  }
  let entities = query.toArray();
  if (typeof input.storey === 'string') {
    const storey = resolveStorey(model.bim, input.storey);
    const baked = bytes === undefined && model.backend.hasPendingChanges();
    const members = (source: Uint8Array) => storeyMembership(storey, source, baked);
    const includes = bytes ? members(bytes) : await withIfcBytes(model, async (source) => members(source));
    entities = entities.filter(includes);
  }
  return typeof input.limit === 'number' ? entities.slice(0, input.limit) : entities;
}

export async function exportIsolation(model: LoadedModel, input: Record<string, unknown>, bytes?: Uint8Array): Promise<Uint32Array | undefined> {
  if (!hasExportFilter(input)) return undefined;
  const isolated = Uint32Array.from(await selectExportEntities(model, input, bytes), (entity) => entity.ref.expressId);
  if (isolated.length === 0) {
    const message = typeof input.type === 'string' && !input.storey && !input.where && !input.limit
      ? `No ${input.type} entities found - nothing to export.`
      : 'Export filters matched no entities - nothing to export.';
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message });
  }
  return isolated;
}
