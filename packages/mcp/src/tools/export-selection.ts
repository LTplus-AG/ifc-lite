/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BimContext, ComparisonOp } from '@ifc-lite/sdk';
import type { JsonSchema } from '../protocol/types.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';

const operators: ComparisonOp[] = ['=', '!=', '>', '<', '>=', '<=', 'contains', 'exists', 'matches'];

export const exportFilterProperties = {
  type: { type: 'string', description: 'Filter by IFC type (for example IfcWall).' },
  storey: { type: 'string', minLength: 1, description: 'Keep entities contained in the named storey or storey express ID.' },
  where: {
    type: 'object',
    description: 'Filter on a property or quantity in a named set.',
    properties: {
      set: { type: 'string', description: 'IFC property or quantity set name.' },
      property: { type: 'string', description: 'Property or quantity name.' },
      operator: { type: 'string', enum: operators },
      value: { type: 'string', description: 'Value to compare. Omit for exists.' },
    },
    required: ['set', 'property', 'operator'],
    additionalProperties: false,
  },
  limit: { type: 'integer', minimum: 1, description: 'Maximum number of matching entities after other filters.' },
} satisfies Record<string, JsonSchema>;

export function hasExportFilter(input: Record<string, unknown>): boolean {
  return !!(input.type || input.where || input.limit) || input.storey != null;
}

export function selectExportEntities(bim: BimContext, input: Record<string, unknown>) {
  let query = bim.query();
  if (typeof input.type === 'string' && input.type) query = query.byType(input.type);
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
    const storey = input.storey.trim();
    if (!storey) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Storey must not be blank.' });
    const storeys = bim.storeys();
    const id = /^#?\d+$/.test(storey) ? Number(storey.replace(/^#/, '')) : undefined;
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
    const contained = new Set(bim.contains(match.ref).map((entity) => entity.ref.expressId));
    entities = entities.filter((entity) => contained.has(entity.ref.expressId));
  }
  return typeof input.limit === 'number' ? entities.slice(0, input.limit) : entities;
}

export function exportIsolation(bim: BimContext, input: Record<string, unknown>): Uint32Array | undefined {
  if (!hasExportFilter(input)) return undefined;
  const isolated = Uint32Array.from(selectExportEntities(bim, input), (entity) => entity.ref.expressId);
  if (isolated.length === 0) {
    const message = typeof input.type === 'string' && !input.storey && !input.where && !input.limit
      ? `No ${input.type} entities found - nothing to export.`
      : 'Export filters matched no entities - nothing to export.';
    throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message });
  }
  return isolated;
}
