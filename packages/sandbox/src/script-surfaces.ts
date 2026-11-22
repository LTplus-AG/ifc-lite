/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  buildSurface, encodeRef, parseRef, QUERY_OPERATORS, VIEWER_ACTIONS,
  type CreateSurfaceMessage,
} from '@ifc-lite/a2ui';
import { z } from 'zod';
import type { AppendUiSurface } from './bridge-ui.js';

const MAX_SURFACES = 8;
const MAX_TABLE_ROWS = 2000;
const MAX_BYTES = 256 * 1024;

const entityRef = z.union([
  z.string().transform((value, ctx) => {
    const ref = parseRef(value);
    if (ref) return encodeRef(ref);
    ctx.addIssue({ code: 'custom', message: 'Expected a modelId:expressId reference' });
    return z.NEVER;
  }),
  z.object({ modelId: z.string().min(1), expressId: z.int().positive() }).transform(encodeRef),
]);
const queryFields = {
  types: z.array(z.string()).optional(),
  where: z.array(z.object({
    path: z.string(),
    op: z.enum(QUERY_OPERATORS),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })).optional(),
  storey: z.string().optional(),
  modelId: z.string().optional(),
};
const query = z.object({ ...queryFields, limit: z.number().optional() }).optional();
const title = z.string().optional();
const tone = z.enum(['neutral', 'info', 'success', 'warn', 'error']).optional();
const refs = z.array(entityRef).optional();
const rowLimit = `A table can have at most ${MAX_TABLE_ROWS} rows`;

const section = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string(), variant: z.enum(['body', 'caption']).optional() }),
  z.object({ kind: z.literal('callout'), text: z.string(), tone, title }),
  z.object({
    kind: z.literal('stats'),
    items: z.array(z.object({
      label: z.string(), value: z.number().optional(), query,
      aggregate: z.enum(['count', 'sum', 'avg', 'min', 'max']).optional(),
      path: z.string().optional(), unit: z.string().optional(), tone,
    })),
  }),
  z.object({
    kind: z.literal('table'),
    columns: z.array(z.object({ path: z.string(), label: z.string().optional() })),
    rows: z.array(z.looseObject({ ref: entityRef.optional() })).max(MAX_TABLE_ROWS, rowLimit).optional(),
    query: z.object({ ...queryFields, limit: z.number().max(MAX_TABLE_ROWS, rowLimit).optional() }).optional(),
    title, groupBy: z.string().optional(), maxRows: z.number().max(MAX_TABLE_ROWS, rowLimit).optional(),
  }),
  z.object({ kind: z.literal('list'), refs, query, title, label: z.string().optional() }),
  z.object({
    kind: z.literal('chart'), groupBy: z.string(), query, title,
    data: z.array(z.object({ label: z.string(), value: z.number(), refs })).optional(),
    chart: z.enum(['bar', 'pie']).optional(), aggregate: z.enum(['count', 'sum']).optional(),
    path: z.string().optional(),
  }),
  z.object({
    kind: z.literal('legend'), by: z.string(), query, title, apply: z.enum(['manual', 'onShow']).optional(),
  }),
  z.object({
    kind: z.literal('actions'), actions: z.array(z.enum(VIEWER_ACTIONS)), refs, query,
    color: z.string().optional(), followUps: z.array(z.object({ label: z.string(), prompt: z.string() })).optional(),
  }),
  z.object({
    kind: z.literal('entity'), entity: entityRef,
    sections: z.array(z.enum(['attributes', 'properties', 'quantities', 'materials', 'classifications', 'spatial'])).optional(),
  }),
]);

// Project only builder inputs. Row values live in the data model, while all
// component properties have explicit schemas that exclude raw A2UI bindings.
const surface = z.object({ title, card: z.boolean().optional(), sections: z.array(section) });
const encoder = new TextEncoder();

function asSurfaceSpec(method: Parameters<AppendUiSurface>[0], input: unknown): unknown {
  if (method === 'show') return input;
  if (method === 'entity') return { sections: [{ kind: method, entity: input }] };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Expected a section spec object');
  }
  return { sections: [{ ...input, kind: method }] };
}

export function createScriptSurfaceCapture() {
  let runId: string | undefined;
  let surfaces: CreateSurfaceMessage[][] = [];
  // Include the enclosing JSON array brackets in the per-run byte budget.
  let bytes = 2;

  const append: AppendUiSurface = (method, input) => {
    if (surfaces.length >= MAX_SURFACES) throw new Error(`At most ${MAX_SURFACES} surfaces are allowed per run`);
    const parsed = surface.safeParse(asSurfaceSpec(method, input));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`Invalid surface ${issue.path.join('.') || 'spec'}: ${issue.message}`);
    }
    runId ??= globalThis.crypto.getRandomValues(new Uint32Array(4)).join('_');
    const surfaceId = `script-${runId}-${surfaces.length + 1}`;
    const messages = buildSurface({ ...parsed.data, surfaceId });
    const size = encoder.encode(JSON.stringify(messages)).byteLength + (surfaces.length ? 1 : 0);
    if (bytes + size > MAX_BYTES) throw new Error('Surfaces exceed the 256 KiB serialized limit per run');
    bytes += size;
    surfaces.push(messages);
    return surfaceId;
  };

  return {
    append,
    reset() {
      runId = undefined;
      surfaces = [];
      bytes = 2;
    },
    take() {
      const result = surfaces.length ? surfaces : undefined;
      surfaces = [];
      return result;
    },
  };
}
