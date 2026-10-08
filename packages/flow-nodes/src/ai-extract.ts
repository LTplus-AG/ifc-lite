/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ai.extract` (#6923): typed candidate records from supplied text passages.
 *
 * Each record names the passage it came from and quotes a source span. A
 * record is `supported` only when that span occurs verbatim in its passage
 * and every value has its field's type; otherwise it is kept as
 * `unsupported` with the offending values blanked, so a reviewer sees what
 * the model claimed. This is a quote-and-type check, not a semantic check
 * that the quoted text entails each typed value. All records remain candidates
 * awaiting human review. Passages beyond
 * `maxPassages`, or past a budget stop, are reported as not sent. The run
 * pauses here for review.
 */

import type { Cell, Column, Table } from '@ifc-lite/flow';
import { SCALAR_ITEM, SCALAR_LIST, TABLE_ITEM } from './ports.js';
import type { FlowNodeDef } from './host.js';
import { AI_CAPABILITY, AI_FEATURE, aiService, positiveInt, requestJson } from './ai-service.js';
import { extractionSchema } from './ai-response-schemas.js';

type FieldType = 'string' | 'number' | 'boolean';
interface Field { readonly name: string; readonly type: FieldType; readonly description: string }

const RESERVED = new Set(['passage', 'span', 'outcome']);

function fieldsOf(value: unknown): Field[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) throw new Error('"fields" must list 1 to 30 { name, type, description } entries');
  const seen = new Set<string>();
  return value.map((f, i) => {
    const name = typeof f?.name === 'string' ? f.name.trim() : '';
    const type = f?.type;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || RESERVED.has(name) || seen.has(name)) throw new Error(`field ${i + 1} needs a unique identifier name other than passage, span or outcome`);
    if (type !== 'string' && type !== 'number' && type !== 'boolean') throw new Error(`field "${name}" must have type string, number or boolean`);
    seen.add(name);
    return { name, type, description: typeof f.description === 'string' ? f.description.slice(0, 300) : '' };
  });
}

/** One reply's records, checked against their passages. */
export function readRecords(value: Record<string, unknown>, passages: ReadonlyMap<number, string>, fields: readonly Field[]): Record<string, Cell>[] {
  const records = Array.isArray(value.records) ? value.records : [];
  return records.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const record = raw as Record<string, unknown>;
    const passage = typeof record.passage === 'number' ? record.passage : -1;
    const source = passages.get(passage);
    if (source === undefined) return [];
    const sourceSpan = typeof record.span === 'string' ? record.span : '';
    const span = sourceSpan.slice(0, 1000);
    const values = record.values && typeof record.values === 'object' ? record.values as Record<string, unknown> : {};
    let supported = sourceSpan.length > 0 && sourceSpan.length <= 1000 && source.includes(sourceSpan);
    const row: Record<string, Cell> = { passage, span };
    for (const f of fields) {
      const v = values[f.name];
      const ok = v === null || v === undefined || (f.type === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === f.type);
      if (!ok) supported = false;
      row[f.name] = ok && v !== undefined ? (v as Cell) : null;
    }
    row.outcome = supported ? 'supported' : 'unsupported';
    return [row];
  });
}

const COLUMN_TYPE: Record<FieldType, Column['type']> = { string: 'text', number: 'real', boolean: 'boolean' };

export const aiExtractNode: FlowNodeDef = {
  type: 'ai.extract', title: 'AI extract records', category: 'ai',
  doc: 'Extract typed records from text passages using the host AI model. Each record quotes its source span; records whose span is not in the passage or whose values have the wrong type are marked unsupported. The run pauses for review of the records.',
  inputs: [{ name: 'passages', type: SCALAR_LIST }],
  outputs: [{ name: 'records', type: TABLE_ITEM }, { name: 'coverage', type: SCALAR_ITEM }],
  params: [
    { name: 'fields', kind: 'json', default: [], doc: '[{ "name": "...", "type": "string|number|boolean", "description": "..." }]' },
    { name: 'maxPassages', kind: 'number', default: 50 },
    { name: 'batchSize', kind: 'number', default: 10 },
    { name: 'maxRecords', kind: 'number', default: 200 },
    { name: 'maxOutputTokens', kind: 'number', default: 2000 },
  ],
  capabilities: [AI_CAPABILITY], requires: { backend: [AI_FEATURE], network: true }, volatile: true, review: 'required',
  run: async (ctx, inputs, p) => {
    const passages = (inputs.passages as unknown[]).map((v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v)));
    const fields = fieldsOf(p.fields);
    const maxPassages = positiveInt(p.maxPassages, 'maxPassages', 1000);
    const batchSize = positiveInt(p.batchSize, 'batchSize', 50);
    const maxRecords = positiveInt(p.maxRecords, 'maxRecords', 5000);
    const maxOutputTokens = positiveInt(p.maxOutputTokens, 'maxOutputTokens', 32_000);
    const service = aiService(ctx);
    const task = [
      'Extract records with these fields from the passages:',
      ...fields.map((f) => `- ${f.name} (${f.type}): ${f.description}`),
      'Reply {"records":[{"passage":<passage number>,"span":"<exact quote from that passage>","values":{...}}]}.',
      'Quote the span verbatim. Use null for a value the passage does not state.',
    ].join('\n');
    const rows: Record<string, Cell>[] = [];
    let requests = 0;
    let sent = 0;
    let failed = 0;
    const sendable = Math.min(passages.length, maxPassages);
    for (let start = 0; start < sendable && rows.length < maxRecords; start += batchSize) {
      const batch = new Map<number, string>();
      for (let i = start; i < Math.min(start + batchSize, sendable); i++) batch.set(i, passages[i].slice(0, 8000));
      const data = [...batch].map(([i, t]) => JSON.stringify({ passage: i, text: t })).join('\n');
      const reply = await requestJson(ctx, service, task, `<data>\n${data}\n</data>`, maxOutputTokens,
        extractionSchema([...batch.keys()], fields));
      if (reply.kind === 'budget') { ctx.log('warn', `the AI budget ran out after ${requests} request(s)`); break; }
      requests += 1;
      sent += batch.size;
      if (reply.kind === 'failed') { failed += batch.size; ctx.log('warn', `passages ${start + 1}-${start + batch.size}: ${reply.message}`); continue; }
      if (!Array.isArray(reply.value.records)) {
        failed += batch.size;
        ctx.log('warn', `passages ${start + 1}-${start + batch.size}: reply must contain a records array`);
        continue;
      }
      rows.push(...readRecords(reply.value, batch, fields));
    }
    if (rows.length > maxRecords) ctx.log('warn', `${rows.length - maxRecords} record(s) beyond maxRecords were dropped`);
    const kept = rows.slice(0, maxRecords);
    const records: Table = {
      key: 'passage',
      columns: [
        { name: 'passage', type: 'integer' }, ...fields.map((f) => ({ name: f.name, type: COLUMN_TYPE[f.type] })),
        { name: 'span', type: 'text' }, { name: 'outcome', type: 'enum' },
      ],
      rows: kept,
    };
    return {
      records,
      coverage: {
        model: service.model, passages: passages.length, sent, failed, notSent: passages.length - sent, requests,
        records: kept.length, unsupported: kept.filter((r) => r.outcome === 'unsupported').length,
      },
    };
  },
};
