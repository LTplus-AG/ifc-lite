/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF (BIM Collaboration Format) tools (spec §7.6).
 *
 * Topics live inside a per-session BCF project that's lazy-created on first
 * write. We keep the project per ToolContext (server-wide, not per-model)
 * so an agent can collect issues across federated models, then export a
 * single .bcfzip via `bcf_export`.
 */

import { writeFile } from 'node:fs/promises';
import {
  addCommentToTopic,
  addTopicToProject,
  addViewpointToTopic,
  createBCFComment,
  createBCFProject,
  createBCFTopic,
  updateTopicStatus,
  writeBCF,
  type BCFProject,
  type BCFTopic,
} from '@ifc-lite/bcf';
import type { Tool } from './types.js';
import { okResult } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { resolveSafePath } from '../safe-path.js';

// One project per server instance. We keep it on a module-level Map keyed by
// session — for stdio that's exactly one entry; for HTTP each session gets
// its own server, so this naturally scopes per-session.
const projectStore = new WeakMap<object, BCFProject>();

function getProject(scopeKey: object): BCFProject {
  let p = projectStore.get(scopeKey);
  if (!p) {
    p = createBCFProject({ name: 'ifc-lite-mcp', version: '2.1' });
    projectStore.set(scopeKey, p);
  }
  return p;
}

function findTopic(project: BCFProject, guid: string): BCFTopic | null {
  return project.topics.get(guid) ?? null;
}

const bcfTopicList: Tool = {
  name: 'bcf_topic_list',
  description: 'List BCF topics in this session, optionally filtered by status.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: { status: { type: 'string' } },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const project = getProject(ctx.registry);
    const filter = input.status as string | undefined;
    const topics = Array.from(project.topics.values())
      .filter((t) => !filter || t.topicStatus === filter)
      .map((t) => ({ guid: t.guid, title: t.title, status: t.topicStatus, type: t.topicType, priority: t.priority, comments: t.comments.length }));
    return okResult(`${topics.length} topic(s).`, { count: topics.length, topics });
  },
};

const bcfTopicCreate: Tool = {
  name: 'bcf_topic_create',
  description: 'Create a new BCF topic. Returns the GUID for follow-up calls.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      author: { type: 'string', default: 'ifc-lite-mcp' },
      type: { type: 'string', default: 'Issue' },
      status: { type: 'string', default: 'Open' },
      priority: { type: 'string' },
      assigned_to: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' } },
    },
    required: ['title'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const project = getProject(ctx.registry);
    const topic = createBCFTopic({
      title: input.title as string,
      description: input.description as string | undefined,
      author: (input.author as string | undefined) ?? 'ifc-lite-mcp',
      topicType: input.type as string | undefined,
      topicStatus: input.status as string | undefined,
      priority: input.priority as string | undefined,
      assignedTo: input.assigned_to as string | undefined,
      labels: input.labels as string[] | undefined,
    });
    addTopicToProject(project, topic);
    return okResult(`Created topic '${topic.title}'.`, { guid: topic.guid, title: topic.title });
  },
};

const bcfTopicUpdate: Tool = {
  name: 'bcf_topic_update',
  description: 'Update topic fields or append a comment.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      guid: { type: 'string' },
      status: { type: 'string' },
      priority: { type: 'string' },
      comment: { type: 'string' },
      modified_by: { type: 'string', default: 'ifc-lite-mcp' },
    },
    required: ['guid'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const project = getProject(ctx.registry);
    const topic = findTopic(project, input.guid as string);
    if (!topic) {
      throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: `Topic ${input.guid} not found.` });
    }
    const author = (input.modified_by as string | undefined) ?? 'ifc-lite-mcp';
    if (typeof input.status === 'string') updateTopicStatus(topic, input.status, author);
    if (typeof input.priority === 'string') topic.priority = input.priority;
    if (typeof input.comment === 'string') {
      const comment = createBCFComment({ author, comment: input.comment });
      addCommentToTopic(topic, comment);
    }
    return okResult('Topic updated.', { guid: topic.guid, status: topic.topicStatus });
  },
};

const bcfTopicClose: Tool = {
  name: 'bcf_topic_close',
  description: 'Mark a topic resolved (status="Closed").',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      guid: { type: 'string' },
      modified_by: { type: 'string', default: 'ifc-lite-mcp' },
    },
    required: ['guid'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const project = getProject(ctx.registry);
    const topic = findTopic(project, input.guid as string);
    if (!topic) {
      throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: `Topic ${input.guid} not found.` });
    }
    updateTopicStatus(topic, 'Closed', (input.modified_by as string | undefined) ?? 'ifc-lite-mcp');
    return okResult(`Closed ${topic.guid}.`, { guid: topic.guid });
  },
};

const bcfViewpointCreate: Tool = {
  name: 'bcf_viewpoint_create',
  description: 'Attach a viewpoint to a topic. Selection-only viewpoints work without camera state; camera/section require a viewer integration.',
  scope: 'mutate',
  inputSchema: {
    type: 'object',
    properties: {
      guid: { type: 'string' },
      selection_global_ids: { type: 'array', items: { type: 'string' } },
    },
    required: ['guid'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const project = getProject(ctx.registry);
    const topic = findTopic(project, input.guid as string);
    if (!topic) throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: `Topic ${input.guid} not found.` });
    const selection = (input.selection_global_ids as string[] | undefined) ?? [];
    const viewpoint = {
      guid: cryptoRandomUuid(),
      components: {
        selection: selection.map((g) => ({ ifcGuid: g, OriginatingSystem: 'ifc-lite-mcp' })),
      },
    };
    addViewpointToTopic(topic, viewpoint as unknown as Parameters<typeof addViewpointToTopic>[1]);
    return okResult(`Viewpoint added (${selection.length} selected).`, { viewpointGuid: viewpoint.guid, selection: selection.length });
  },
};

const bcfExport: Tool = {
  name: 'bcf_export',
  description: 'Export the in-memory BCF project as a .bcfzip file.',
  scope: 'export',
  inputSchema: {
    type: 'object',
    properties: { file_path: { type: 'string' } },
    required: ['file_path'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const project = getProject(ctx.registry);
    const filePath = await resolveSafePath(input.file_path, ctx, 'write');
    const blob = (await writeBCF(project)) as unknown as Blob;
    const buffer = Buffer.from(await blob.arrayBuffer());
    await writeFile(filePath, buffer);
    return okResult(`Wrote BCF (${buffer.length.toLocaleString()} bytes, ${project.topics.size} topic(s)) to ${filePath}.`, {
      filePath,
      bytes: buffer.length,
      topicCount: project.topics.size,
    });
  },
};

function cryptoRandomUuid(): string {
  // Node 18+ globalThis.crypto.randomUUID is always available.
  return (globalThis.crypto as { randomUUID(): string }).randomUUID();
}

export const bcfTools: Tool[] = [bcfTopicList, bcfTopicCreate, bcfTopicUpdate, bcfTopicClose, bcfViewpointCreate, bcfExport];
