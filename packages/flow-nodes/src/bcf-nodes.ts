/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bcf.listTopics` / `bcf.createTopic` / `bcf.addComment` — flow nodes over
 * a BCF API (OpenCDE) server via `@ifc-lite/bcf-api`'s `BcfApiClient`
 * (#5167 phase 3.4). All network I/O goes through the gated transport built
 * in `bcf-client.ts`; see that module for the grant and token handling.
 *
 * Like `http.request`, every node here is `volatile` (a rerun asks the
 * server again rather than replaying a memoised answer: a topic not
 * created, a list stale) and `requires.network`.
 */

import type { BcfTopicDto, BcfTopicWriteDto } from '@ifc-lite/bcf-api';
import type { Cell, Column, Row, Table } from '@ifc-lite/flow';
import { BCF_CONNECTION_PARAMS, bcfClientFor, requiredString, withBcfErrors } from './bcf-client.js';
import { ANY_ITEM, ANY_LIST, SCALAR_ITEM, SCALAR_LIST, TABLE_ITEM, type FlowNodeDef } from './host.js';
import { tableOf } from './table-nodes.js';

const NETWORK = { capabilities: ['network.fetch:*'], requires: { network: true }, volatile: true } as const;

/** Labels travel through a table cell as one `;`-separated string. */
const LABEL_SEPARATOR = ';';

/** The `bcf.listTopics` table's columns; `bcf.createTopic` reads rows by the same names. */
const TOPIC_COLUMNS: readonly Column[] = [
  { name: 'guid', type: 'identifier' },
  { name: 'title', type: 'string' },
  { name: 'status', type: 'string' },
  { name: 'type', type: 'string' },
  { name: 'priority', type: 'string' },
  { name: 'assigned_to', type: 'string' },
  { name: 'creation_date', type: 'string' },
  { name: 'modified_date', type: 'string' },
  { name: 'labels', type: 'string' },
  { name: 'description', type: 'string' },
];

function topicsTable(topics: readonly BcfTopicDto[]): Table {
  const rows: Row[] = topics.map((t) => ({
    guid: t.guid,
    title: t.title ?? null,
    status: t.topic_status ?? null,
    type: t.topic_type ?? null,
    priority: t.priority ?? null,
    assigned_to: t.assigned_to ?? null,
    creation_date: t.creation_date ?? null,
    modified_date: t.modified_date ?? null,
    labels: t.labels && t.labels.length > 0 ? t.labels.join(LABEL_SEPARATOR) : null,
    description: t.description ?? null,
  }));
  return { columns: TOPIC_COLUMNS, rows, key: 'guid' };
}

/** A trimmed non-empty string, or `undefined`. */
function text(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

function labelsOf(v: unknown): string[] | undefined {
  const parts = Array.isArray(v) ? v.map((x) => String(x)) : typeof v === 'string' ? v.split(LABEL_SEPARATOR) : [];
  const labels = parts.map((s) => s.trim()).filter((s) => s.length > 0);
  return labels.length > 0 ? labels : undefined;
}

/** Topic fields from the node's params, each overridden by a non-empty cell of `row` when one is given. */
function topicWrite(params: Readonly<Record<string, unknown>>, row: Readonly<Record<string, Cell>> | undefined, where: string): BcfTopicWriteDto {
  const pick = (column: string, param: string): string | undefined => text(row?.[column]) ?? text(params[param]);
  const title = pick('title', 'title');
  if (!title) throw new Error(`bcf.createTopic: ${where} has no title`);
  const out: { -readonly [K in keyof BcfTopicWriteDto]: BcfTopicWriteDto[K] } = { title };
  const description = pick('description', 'description');
  const type = pick('type', 'type');
  const status = pick('status', 'status');
  const priority = pick('priority', 'priority');
  const assignedTo = pick('assigned_to', 'assignedTo');
  const labels = labelsOf(row?.labels) ?? labelsOf(params.labels);
  if (description) out.description = description;
  if (type) out.topic_type = type;
  if (status) out.topic_status = status;
  if (priority) out.priority = priority;
  if (assignedTo) out.assigned_to = assignedTo;
  if (labels) out.labels = labels;
  return out;
}

export const bcfNodes: FlowNodeDef[] = [
  {
    type: 'bcf.listTopics',
    title: 'BCF List Topics',
    category: 'bcf',
    doc: 'Lists a BCF API project\'s topics as a table (one row per topic, keyed by `guid`; labels `;`-separated) plus the raw topic list. Requests go only to a host covered by a granted `network.fetch:<host>` capability.',
    inputs: [],
    outputs: [
      { name: 'table', type: TABLE_ITEM },
      { name: 'topics', type: ANY_LIST },
      { name: 'count', type: SCALAR_ITEM },
    ],
    params: [
      ...BCF_CONNECTION_PARAMS,
      { name: 'filter', kind: 'string', default: '', doc: 'OData $filter, e.g. topic_status eq \'Open\'.' },
      { name: 'orderby', kind: 'string', default: '', doc: 'OData $orderby, e.g. creation_date desc.' },
      { name: 'top', kind: 'number', default: 0, doc: 'OData $top; 0 lists every topic the server returns.' },
    ],
    ...NETWORK,
    run: (ctx, _i, p) => withBcfErrors('bcf.listTopics', async () => {
      const { client, projectId } = bcfClientFor(ctx, 'bcf.listTopics', p);
      const top = Number(p.top);
      const topics = await client.getTopics(projectId, {
        filter: text(p.filter),
        orderby: text(p.orderby),
        top: Number.isInteger(top) && top > 0 ? top : undefined,
      });
      return { table: topicsTable(topics), topics, count: topics.length };
    }),
  },
  {
    type: 'bcf.createTopic',
    title: 'BCF Create Topic',
    category: 'bcf',
    doc: 'Creates a topic in a BCF API project from the params — or, with `rows` connected, one topic per row, reading the `bcf.listTopics` column names (title, description, type, status, priority, assigned_to, labels) and falling back to the params for empty cells. Every row is validated before the first request.',
    inputs: [{ name: 'rows', type: TABLE_ITEM, optional: true, doc: 'Optional table: one topic per row.' }],
    outputs: [
      { name: 'guids', type: SCALAR_LIST },
      { name: 'topics', type: ANY_LIST },
    ],
    params: [
      ...BCF_CONNECTION_PARAMS,
      { name: 'title', kind: 'string', default: '' },
      { name: 'description', kind: 'string', default: '' },
      { name: 'type', kind: 'string', default: '', doc: 'topic_type, e.g. Issue.' },
      { name: 'status', kind: 'string', default: '', doc: 'topic_status, e.g. Open.' },
      { name: 'priority', kind: 'string', default: '' },
      { name: 'assignedTo', kind: 'string', default: '', doc: 'assigned_to user id.' },
      { name: 'labels', kind: 'string', default: '', doc: '`;`-separated labels.' },
    ],
    ...NETWORK,
    run: (ctx, i, p) => withBcfErrors('bcf.createTopic', async () => {
      const { client, projectId } = bcfClientFor(ctx, 'bcf.createTopic', p);
      const writes = i.rows === undefined
        ? [topicWrite(p, undefined, 'the node')]
        : tableOf(i.rows).rows.map((row, idx) => topicWrite(p, row, `row ${idx + 1}`));
      const topics: BcfTopicDto[] = [];
      for (const write of writes) {
        try {
          topics.push(await client.createTopic(projectId, write));
        } catch (err) {
          // Name what already exists on the server, so a rerun does not duplicate it blindly.
          if (topics.length === 0) throw err;
          const done = topics.map((t) => t.guid).join(', ');
          throw new Error(`bcf.createTopic: failed after creating ${topics.length} topic(s) [${done}]: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
      }
      ctx.log('info', `created ${topics.length} topic(s)`);
      return { guids: topics.map((t) => t.guid), topics };
    }),
  },
  {
    type: 'bcf.addComment',
    title: 'BCF Add Comment',
    category: 'bcf',
    doc: 'Adds a comment to a BCF topic. `topicGuid`/`comment` inputs override the params, so wiring `bcf.createTopic`\'s `guids` comments on each new topic.',
    inputs: [
      { name: 'topicGuid', type: SCALAR_ITEM, optional: true },
      { name: 'comment', type: SCALAR_ITEM, optional: true },
    ],
    outputs: [
      { name: 'guid', type: SCALAR_ITEM },
      { name: 'created', type: ANY_ITEM },
    ],
    params: [
      ...BCF_CONNECTION_PARAMS,
      { name: 'topicGuid', kind: 'string', default: '' },
      { name: 'comment', kind: 'string', default: '' },
      { name: 'replyToCommentGuid', kind: 'string', default: '' },
    ],
    ...NETWORK,
    run: (ctx, i, p) => withBcfErrors('bcf.addComment', async () => {
      const { client, projectId } = bcfClientFor(ctx, 'bcf.addComment', p);
      const merged = { topicGuid: text(i.topicGuid) ?? p.topicGuid, comment: text(i.comment) ?? p.comment };
      const topicGuid = requiredString('bcf.addComment', merged, 'topicGuid');
      const comment = requiredString('bcf.addComment', merged, 'comment');
      const replyTo = text(p.replyToCommentGuid);
      const created = await client.createComment(projectId, topicGuid, replyTo ? { comment, reply_to_comment_guid: replyTo } : { comment });
      return { guid: created.guid, created };
    }),
  },
];
