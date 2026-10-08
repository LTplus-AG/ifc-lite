/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ai.summarize` (#6923): structured narrative sections over evidence rows,
 * each citing the row keys it rests on.
 *
 * One request over at most `maxRows` rows. A citation is kept only when it
 * names a row that was sent; a section left with no valid citation is kept
 * as `uncited` so a reviewer sees it was unsupported instead of losing it.
 * The run pauses here for review.
 */

import type { Table } from '@ifc-lite/flow';
import { SCALAR_ITEM, TABLE_ITEM } from './ports.js';
import type { FlowNodeDef } from './host.js';
import { AI_CAPABILITY, AI_FEATURE, aiService, dataBlock, positiveInt, requestJson, rowKeys, sentColumns } from './ai-service.js';
import { summarySchema } from './ai-response-schemas.js';

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export const aiSummarizeNode: FlowNodeDef = {
  type: 'ai.summarize', title: 'AI summarize evidence', category: 'ai',
  doc: 'Write short narrative sections over the rows using the host AI model. Each section cites the row keys it rests on; sections without a valid citation are marked uncited. The run pauses for review of the sections.',
  inputs: [{ name: 'table', type: TABLE_ITEM }],
  outputs: [{ name: 'sections', type: TABLE_ITEM }, { name: 'coverage', type: SCALAR_ITEM }],
  params: [
    { name: 'audience', kind: 'string', default: 'BIM coordinator' },
    { name: 'language', kind: 'string', default: 'en', doc: 'BCP 47 language tag for the sections.' },
    { name: 'maxSections', kind: 'number', default: 6 },
    { name: 'columns', kind: 'json', default: [], doc: 'Columns sent to the model; select at least one explicitly.' },
    { name: 'maxRows', kind: 'number', default: 200 },
    { name: 'maxOutputTokens', kind: 'number', default: 2000 },
  ],
  capabilities: [AI_CAPABILITY], requires: { backend: [AI_FEATURE], network: true }, volatile: true, review: 'required',
  run: async (ctx, inputs, p) => {
    const table = inputs.table as Table;
    const columns = sentColumns(table, Array.isArray(p.columns) ? p.columns.map(String) : []);
    const maxRows = positiveInt(p.maxRows, 'maxRows', 2000);
    const maxSections = positiveInt(p.maxSections, 'maxSections', 20);
    const service = aiService(ctx);
    const keys = rowKeys(table);
    const sent = keys.map((_, i) => i).slice(0, maxRows);
    const known = new Set(sent.map((i) => keys[i]));
    const task = [
      `Summarize the data for a ${text(p.audience, 80) || 'BIM coordinator'} in language "${text(p.language, 20) || 'en'}", in at most ${maxSections} sections.`,
      'Reply {"sections":[{"heading":"...","text":"...","citations":["<row key>"]}]}.',
      'Every statement must rest on the cited rows; state only what the rows show.',
    ].join('\n');
    const reply = await requestJson(ctx, service, task, dataBlock(table, keys, sent, columns), positiveInt(p.maxOutputTokens, 'maxOutputTokens', 32_000),
      summarySchema([...known]));
    const budgetStopped = reply.kind === 'budget';
    if (budgetStopped) ctx.log('warn', 'the AI budget ran out; all evidence rows remain not sent');
    if (reply.kind === 'failed') throw new Error(reply.message);
    if (reply.kind === 'value' && !Array.isArray(reply.value.sections)) throw new Error('the reply has no sections array');
    const raw = reply.kind === 'value' ? reply.value.sections as unknown[] : [];
    if (raw.length > maxSections) ctx.log('warn', `${raw.length - maxSections} section(s) beyond maxSections were dropped`);
    const rows = raw.slice(0, maxSections).flatMap((s) => {
      if (!s || typeof s !== 'object') return [];
      const section = s as Record<string, unknown>;
      const body = text(section.text, 4000);
      if (!body) return [];
      const citations = Array.isArray(section.citations)
        ? [...new Set(section.citations.filter((c): c is string => typeof c === 'string' && known.has(c)))]
        : [];
      return [{ heading: text(section.heading, 200), text: body, citations: citations.join(', '), outcome: citations.length > 0 ? 'cited' : 'uncited' }];
    });
    if (keys.length > maxRows) ctx.log('warn', `${keys.length - maxRows} row(s) beyond maxRows ${maxRows} were not sent`);
    const sections: Table = {
      key: 'heading',
      columns: [{ name: 'heading', type: 'text' }, { name: 'text', type: 'text' }, { name: 'citations', type: 'text' }, { name: 'outcome', type: 'enum' }],
      rows,
    };
    return {
      sections,
      coverage: {
        model: service.model, rows: keys.length, sent: budgetStopped ? 0 : sent.length, notSent: budgetStopped ? keys.length : keys.length - sent.length, requests: budgetStopped ? 0 : 1, budgetStopped,
        sections: rows.length, uncited: rows.filter((r) => r.outcome === 'uncited').length,
      },
    };
  },
};
