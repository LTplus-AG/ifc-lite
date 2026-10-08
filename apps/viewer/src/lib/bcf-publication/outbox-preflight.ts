/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Check queued writes against the selected project's real authorization
 * and extensions before anything is sent (#6896). A value outside an
 * advertised vocabulary, an assignee not in `user_id_type`, or a missing
 * `createTopic` project action refuses the whole dispatch with nothing sent.
 * Where the server advertises nothing, the write proceeds with a warning and
 * the server's own refusal is recorded as a definite failure.
 */

import type { BcfApiClient, BcfExtensionsDto, BcfRequestOptions } from '@ifc-lite/bcf-api';
import type { BcfPublication } from './outbox-types.js';

export interface PreflightIssue {
  kind: 'permission' | 'vocabulary' | 'assignee' | 'unverified';
  entryId?: string;
  topicGuid?: string;
  field?: string;
  value?: string;
  allowed?: string[];
}

export interface PreflightReport {
  ok: boolean;
  at: string;
  /** Refusals: nothing is dispatched while any exists. */
  issues: PreflightIssue[];
  /** Capabilities the server did not advertise; the write relies on the server's own check. */
  warnings: PreflightIssue[];
  extensions: BcfExtensionsDto;
  projectActions?: string[];
}

export type PreflightClient = Pick<BcfApiClient, 'getProject' | 'getExtensions'>;

const VOCABULARY: Array<[field: string, list: keyof BcfExtensionsDto]> = [
  ['topic_type', 'topic_type'], ['topic_status', 'topic_status'], ['priority', 'priority'], ['stage', 'stage'],
];

function allowed(list: unknown): string[] | undefined {
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : undefined;
}

export async function preflightPublication(client: PreflightClient, record: BcfPublication, request: BcfRequestOptions = {},
  now = new Date()): Promise<PreflightReport> {
  const projectId = record.target.projectId;
  const [project, extensions] = await Promise.all([client.getProject(projectId, request), client.getExtensions(projectId, request)]);
  const issues: PreflightIssue[] = [], warnings: PreflightIssue[] = [];
  const queued = record.entries.filter(entry => entry.state === 'queued');
  const projectActions = allowed(project.authorization?.project_actions) ?? allowed(extensions.project_actions);
  if (queued.some(entry => entry.operation === 'createTopic')) {
    if (!projectActions) warnings.push({ kind: 'unverified', field: 'project_actions' });
    else if (!projectActions.includes('createTopic')) issues.push({ kind: 'permission', field: 'project_actions', value: 'createTopic', allowed: projectActions });
  }
  for (const entry of queued) {
    if (entry.operation !== 'createTopic' && entry.operation !== 'updateTopic') continue;
    const at = { entryId: entry.id, topicGuid: entry.topicGuid };
    const check = (field: string, value: unknown, list: string[] | undefined, kind: PreflightIssue['kind']) => {
      if (value === undefined || value === null) return;
      const text = String(value);
      if (!list) warnings.push({ ...at, kind: 'unverified', field, value: text });
      else if (!list.includes(text)) issues.push({ ...at, kind, field, value: text, allowed: list });
    };
    for (const [field, list] of VOCABULARY) check(field, entry.payload[field], allowed(extensions[list]), 'vocabulary');
    const labels = entry.payload.labels;
    if (Array.isArray(labels)) for (const label of labels) check('labels', label, allowed(extensions.topic_label), 'vocabulary');
    // An assignee is never sent unverified: it must be one of the project's own users.
    const assignee = entry.payload.assigned_to;
    if (assignee !== undefined && assignee !== null) {
      const users = allowed(extensions.user_id_type) ?? [];
      if (!users.includes(String(assignee))) issues.push({ ...at, kind: 'assignee', field: 'assigned_to', value: String(assignee), allowed: users });
    }
  }
  return { ok: issues.length === 0, at: now.toISOString(), issues, warnings, extensions, ...(projectActions ? { projectActions } : {}) };
}
