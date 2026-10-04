/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Controlled HTTP peer for publication/recovery tests, not a conformance server. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { BcfCommentDto, BcfTopicDto, BcfViewpointDto } from '@ifc-lite/bcf-api';

export const LOCAL_BCF_PROJECT = '00000000-0000-4000-8000-000000000001';
export const LOCAL_BCF_TOKEN = 'local-test-token';
export const LOCAL_BCF_USER = 'coordinator@example.test';
const DATE = '2026-10-04T12:00:00Z';
const STATUSES = ['Open', 'Resolved'];
const TYPES = ['Issue', 'Clash'];
const PRIORITIES = ['Normal', 'High'];

interface StoredTopic {
  topic: BcfTopicDto;
  comments: BcfCommentDto[];
  viewpoints: BcfViewpointDto[];
}
export interface LocalBcfState {
  topics: Map<string, StoredTopic>;
  writesAllowed: boolean;
  tokenValid: boolean;
  /** Close the connection after the next accepted write is committed. */
  loseNextWriteResponse: boolean;
  acceptedWrites: number;
  receivedWrites: number;
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
async function body(request: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > 1_000_000) throw new Error('Test request exceeds 1 MB');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** Independent server validation: unsupported fields/vocabulary fail before commit. */
function topicFields(value: unknown): Record<string, unknown> | undefined {
  if (!record(value) || typeof value.title !== 'string' || !value.title.trim()) return;
  const keys = ['title', 'description', 'topic_type', 'topic_status', 'priority', 'labels', 'assigned_to', 'stage', 'due_date'];
  if (Object.keys(value).some(key => !keys.includes(key))) return;
  for (const [key, values] of [['topic_status', STATUSES], ['topic_type', TYPES], ['priority', PRIORITIES]] as const) {
    const field = value[key];
    if (field !== undefined && field !== null && (typeof field !== 'string' || !values.includes(field))) return;
  }
  for (const key of keys.filter(key => key !== 'labels')) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') return;
  }
  if (value.labels !== undefined && value.labels !== null &&
      (!Array.isArray(value.labels) || !value.labels.every(label => typeof label === 'string'))) return;
  return value;
}

export async function startLocalBcfServer(): Promise<{
  baseUrl: string;
  state: LocalBcfState;
  close: () => Promise<void>;
}> {
  const state: LocalBcfState = { topics: new Map(), writesAllowed: true, tokenValid: true,
    loseNextWriteResponse: false, acceptedWrites: 0, receivedWrites: 0 };
  let baseUrl = '';
  const commit = (response: ServerResponse, value: unknown, status = 201): void => {
    state.acceptedWrites += 1;
    if (state.loseNextWriteResponse) {
      state.loseNextWriteResponse = false;
      response.destroy();
    } else json(response, value, status);
  };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', baseUrl);
    const method = request.method ?? 'GET';
    if (method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (url.pathname === '/bcf/2.1/auth') {
      json(response, { oauth2_auth_url: `${baseUrl}/oauth/authorize`, oauth2_token_url: `${baseUrl}/oauth/token` }); return;
    }
    if (url.pathname === '/bcf/versions') { json(response, { versions: [{ version_id: '2.1' }] }); return; }
    if (!state.tokenValid || request.headers.authorization !== `Bearer ${LOCAL_BCF_TOKEN}`) {
      json(response, { message: 'Local test token rejected' }, 401); return;
    }
    if (url.pathname === '/bcf/2.1/current-user') {
      json(response, { id: LOCAL_BCF_USER, name: 'Local coordinator' }); return;
    }
    const project = { project_id: LOCAL_BCF_PROJECT, name: 'Local coordination',
      authorization: { project_actions: state.writesAllowed ? ['createTopic'] : [] } };
    if (url.pathname === '/bcf/2.1/projects') { json(response, [project]); return; }
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'bcf' || parts[1] !== '2.1' || parts[2] !== 'projects' || parts[3] !== LOCAL_BCF_PROJECT) {
      json(response, { message: 'Unknown project or route' }, 404); return;
    }
    if (parts.length === 4) { json(response, project); return; }
    if (parts[4] === 'extensions') {
      json(response, { topic_type: TYPES, topic_status: STATUSES, priority: PRIORITIES,
        user_id_type: [LOCAL_BCF_USER], project_actions: project.authorization.project_actions }); return;
    }
    if (parts[4] !== 'topics') { json(response, { message: 'Unknown route' }, 404); return; }
    const write = method === 'POST' || method === 'PUT';
    if (write) {
      state.receivedWrites += 1;
      if (!state.writesAllowed) { json(response, { message: 'Project write permission revoked' }, 403); return; }
    }
    if (parts.length === 5) {
      if (method === 'GET') {
        const all = [...state.topics.values()].map(item => item.topic);
        const skip = Number(url.searchParams.get('$skip') ?? 0);
        const top = Number(url.searchParams.get('$top') ?? all.length);
        json(response, all.slice(skip, skip + top)); return;
      }
      if (method === 'POST') {
        const fields = topicFields(await body(request));
        if (!fields) { json(response, { message: 'Invalid topic fields or project vocabulary' }, 400); return; }
        const topic: BcfTopicDto = { ...fields, guid: randomUUID(), title: String(fields.title),
          creation_date: DATE, creation_author: LOCAL_BCF_USER, modified_date: DATE,
          authorization: { topic_actions: ['update', 'createComment', 'createViewpoint'] } };
        state.topics.set(topic.guid, { topic, comments: [], viewpoints: [] });
        commit(response, topic); return;
      }
    }
    const stored = state.topics.get(parts[5]);
    if (!stored) { json(response, { message: 'Unknown topic' }, 404); return; }
    if (parts.length === 6) {
      if (method === 'GET') { json(response, stored.topic); return; }
      if (method === 'PUT') {
        const fields = topicFields(await body(request));
        if (!fields) { json(response, { message: 'Invalid topic fields or project vocabulary' }, 400); return; }
        stored.topic = { ...stored.topic, ...fields, modified_author: LOCAL_BCF_USER };
        commit(response, stored.topic, 200); return;
      }
    }
    if (parts[6] === 'comments' && parts.length === 7) {
      if (method === 'GET') { json(response, stored.comments); return; }
      if (method === 'POST') {
        const value = await body(request);
        if (!record(value) || typeof value.comment !== 'string' || !value.comment.trim()) {
          json(response, { message: 'Comment text required' }, 400); return;
        }
        const comment: BcfCommentDto = { guid: randomUUID(), comment: value.comment, date: DATE,
          author: LOCAL_BCF_USER, topic_guid: stored.topic.guid,
          viewpoint_guid: typeof value.viewpoint_guid === 'string' ? value.viewpoint_guid : undefined };
        stored.comments.push(comment); commit(response, comment); return;
      }
    }
    if (parts[6] === 'viewpoints') {
      if (parts.length === 7) {
        if (method === 'GET') { json(response, stored.viewpoints); return; }
        if (method === 'POST') {
          const value = await body(request);
          if (!record(value) || typeof value.guid !== 'string' || !value.guid) {
            json(response, { message: 'Viewpoint guid required' }, 400); return;
          }
          if (stored.viewpoints.some(viewpoint => viewpoint.guid === value.guid)) {
            json(response, { message: 'Viewpoint already exists' }, 409); return;
          }
          // JSON payload is retained independently; production mapping occurs only on pull.
          const viewpoint = value as unknown as BcfViewpointDto;
          stored.viewpoints.push(viewpoint); commit(response, viewpoint); return;
        }
      }
      const viewpoint = stored.viewpoints.find(item => item.guid === parts[7]);
      if (viewpoint && method === 'GET') {
        if (parts.length === 8) { json(response, viewpoint); return; }
        if (parts[8] === 'selection') { json(response, { selection: viewpoint.components?.selection }); return; }
        if (parts[8] === 'coloring') { json(response, { coloring: viewpoint.components?.coloring }); return; }
        if (parts[8] === 'visibility') { json(response, { visibility: viewpoint.components?.visibility }); return; }
      }
    }
    json(response, { message: 'Unsupported local test route' }, 404);
  };
  const server = createServer((request, response) => {
    // Only local browser journeys; the listener and all data remain loopback-only.
    const origin = request.headers.origin;
    if (origin) {
      if (!URL.canParse(origin)) {
        json(response, { message: 'Local viewer origin required' }, 403); return;
      }
      const parsed = new URL(origin);
      if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
        json(response, { message: 'Only local viewer origins are supported' }, 403); return;
      }
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    void handle(request, response).catch(error => {
      console.warn('[Local BCF test server] request failed', error);
      if (!response.headersSent && !response.destroyed) json(response, { message: 'Invalid test request' }, 400);
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local BCF server has no TCP address');
  baseUrl = `http://127.0.0.1:${address.port}/bcf`;
  return { baseUrl, state, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => { if (error) reject(error); else resolve(); });
    server.closeAllConnections();
  }) };
}
