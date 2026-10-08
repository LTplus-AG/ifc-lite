/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ai.classify` (#6923): label every row of a table with one of a versioned
 * set of categories, in bounded batches.
 *
 * The node sends at most `maxRows` rows, `batchSize` per request, and every
 * request spends the run's root budget. Each output row carries an outcome:
 *
 *   classified  an allowed label plus at least one cited column of that row
 *   unknown     the model said so, named a label outside the set, or cited nothing usable
 *   failed      its batch's request failed (timeout, error, truncated or unusable reply)
 *   not-sent    beyond `maxRows`, or the root budget ran out before its batch
 *
 * so a budget stop still yields a partial draft whose coverage says exactly
 * what was not classified. The result is a proposal: the run pauses here for
 * review and nothing downstream sees it until it is approved.
 */

import type { Table } from '@ifc-lite/flow';
import { SCALAR_ITEM, TABLE_ITEM } from './ports.js';
import type { FlowNodeDef } from './host.js';
import { AI_CAPABILITY, AI_FEATURE, aiService, dataBlock, positiveInt, requestJson, rowKeys, sentColumns } from './ai-service.js';
import { classificationSchema } from './ai-response-schemas.js';

type Outcome = 'classified' | 'unknown' | 'failed' | 'not-sent';

interface Category {
  readonly label: string;
  readonly definition: string;
}

function categoriesOf(value: unknown): Category[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) throw new Error('"categories" must list 1 to 50 { label, definition } entries');
  const seen = new Set<string>();
  return value.map((c, i) => {
    const label = typeof c?.label === 'string' ? c.label.trim() : '';
    if (!label || label.length > 80 || label === 'unknown' || seen.has(label)) throw new Error(`category ${i + 1} needs a unique label other than "unknown"`);
    seen.add(label);
    return { label, definition: typeof c.definition === 'string' ? c.definition.slice(0, 500) : '' };
  });
}

/** Read one batch reply into per-row results; anything not provable stays `unknown`. */
export function readClassifications(
  value: Record<string, unknown>, batchKeys: ReadonlySet<string>, labels: ReadonlySet<string>, columns: ReadonlySet<string>,
): Map<string, { label: string | null; evidence: string[] }> {
  const out = new Map<string, { label: string | null; evidence: string[] }>();
  const items = Array.isArray(value.items) ? value.items : [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const key = typeof item.key === 'string' ? item.key : null;
    if (key === null || !batchKeys.has(key) || out.has(key)) continue;
    const evidence = Array.isArray(item.evidence) ? [...new Set(item.evidence.filter((e): e is string => typeof e === 'string' && columns.has(e)))] : [];
    const label = typeof item.label === 'string' && labels.has(item.label) && evidence.length > 0 ? item.label : null;
    out.set(key, { label, evidence: label ? evidence : [] });
  }
  return out;
}

export const aiClassifyNode: FlowNodeDef = {
  type: 'ai.classify', title: 'AI classify rows', category: 'ai',
  doc: 'Label each row with one of the listed categories using the host AI model. Rows carry an outcome (classified, unknown, failed, not-sent) and the columns cited as evidence. The run pauses for review of the labels.',
  inputs: [{ name: 'table', type: TABLE_ITEM }],
  outputs: [{ name: 'table', type: TABLE_ITEM }, { name: 'coverage', type: SCALAR_ITEM }],
  params: [
    { name: 'categories', kind: 'json', default: [], doc: '[{ "label": "...", "definition": "..." }]' },
    { name: 'version', kind: 'string', default: '1', doc: 'Version of the category definitions, kept with the result.' },
    { name: 'columns', kind: 'json', default: [], doc: 'Columns sent to the model; select at least one explicitly.' },
    { name: 'maxRows', kind: 'number', default: 200 },
    { name: 'batchSize', kind: 'number', default: 25 },
    { name: 'maxOutputTokens', kind: 'number', default: 2000, doc: 'Output ceiling per request.' },
  ],
  capabilities: [AI_CAPABILITY], requires: { backend: [AI_FEATURE], network: true }, volatile: true, review: 'required',
  run: async (ctx, inputs, p) => {
    const table = inputs.table as Table;
    const categories = categoriesOf(p.categories);
    const columns = sentColumns(table, Array.isArray(p.columns) ? p.columns.map(String) : []);
    const maxRows = positiveInt(p.maxRows, 'maxRows', 5000);
    const batchSize = positiveInt(p.batchSize, 'batchSize', 100);
    const maxOutputTokens = positiveInt(p.maxOutputTokens, 'maxOutputTokens', 32_000);
    const service = aiService(ctx);
    const keys = rowKeys(table);
    const outcome: Outcome[] = keys.map(() => 'not-sent');
    const label: (string | null)[] = keys.map(() => null);
    const evidence: string[][] = keys.map(() => []);
    const labels = new Set(categories.map((c) => c.label));
    const task = [
      `Classify each data row into exactly one category (definitions version ${String(p.version)}):`,
      ...categories.map((c) => `- ${c.label}: ${c.definition}`),
      'Reply {"items":[{"key":"<row key>","label":"<category label or unknown>","evidence":["<column name>"]}]} with one item per row.',
      'Cite the column names whose values justify the label. Use "unknown" when the data does not decide it.',
    ].join('\n');
    let requests = 0;
    const sendable = keys.map((_, i) => i).slice(0, maxRows);
    for (let start = 0; start < sendable.length; start += batchSize) {
      const batch = sendable.slice(start, start + batchSize);
      const reply = await requestJson(ctx, service, task, dataBlock(table, keys, batch, columns), maxOutputTokens,
        classificationSchema(batch.map(i => keys[i]), [...labels], columns));
      if (reply.kind === 'budget') {
        ctx.log('warn', `the AI budget ran out after ${requests} request(s); ${sendable.length - start} row(s) were not sent`);
        break;
      }
      requests += 1;
      if (reply.kind === 'failed' || !Array.isArray(reply.value.items)) {
        ctx.log('warn', `rows ${start + 1}-${start + batch.length}: ${reply.kind === 'failed' ? reply.message : 'the reply has no items array'}`);
        for (const i of batch) outcome[i] = 'failed';
        continue;
      }
      const read = readClassifications(reply.value, new Set(batch.map((i) => keys[i])), labels, new Set(columns));
      for (const i of batch) {
        const r = read.get(keys[i]);
        label[i] = r?.label ?? null;
        evidence[i] = r?.evidence ?? [];
        outcome[i] = r === undefined ? 'failed' : r.label ? 'classified' : 'unknown';
      }
    }
    if (keys.length > maxRows) ctx.log('warn', `${keys.length - maxRows} row(s) beyond maxRows ${maxRows} were not sent`);
    const count = (o: Outcome) => outcome.filter((x) => x === o).length;
    const result: Table = {
      key: 'key',
      columns: [
        { name: 'key', type: 'identifier' }, { name: 'label', type: 'label' },
        { name: 'evidence', type: 'text' }, { name: 'outcome', type: 'enum' },
      ],
      rows: keys.map((key, i) => ({ key, label: label[i], evidence: evidence[i].join(', '), outcome: outcome[i] })),
    };
    return {
      table: result,
      coverage: {
        model: service.model, categoriesVersion: String(p.version), rows: keys.length, requests,
        classified: count('classified'), unknown: count('unknown'), failed: count('failed'), notSent: count('not-sent'),
      },
    };
  },
};
