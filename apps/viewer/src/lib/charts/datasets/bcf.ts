/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `bcf` chart dataset (#3944): one row per topic of the loaded BCF
 * project. A topic's elements are the union of its viewpoints' component
 * GUIDs resolved against the loaded models — a topic whose components are
 * not loaded still charts, it just selects nothing.
 *
 * The date columns (`Created`, `Modified`, `Due`, `Closed`) are what a
 * `timeline` chart buckets into weeks; `Closed` is the last modification of
 * a topic whose status is a closed one. No run history is kept anywhere, so
 * BCF dates are the only time axis there is.
 */
import type { ChartDataset, ChartDatasetColumn, ChartDatasetRow } from '@ifc-lite/charts';
import type { BCFTopic } from '@ifc-lite/bcf';
import type { ViewerState } from '@/store';
import { globalIdToExpressId } from '@/hooks/bcfIdLookup';

export const BCF_COLUMNS = {
  status: 'Status',
  type: 'Type',
  priority: 'Priority',
  assignedTo: 'AssignedTo',
  stage: 'Stage',
  labels: 'Labels',
  author: 'Author',
  due: 'DueBucket',
  created: 'Created',
  modified: 'Modified',
  dueDate: 'Due',
  closed: 'Closed',
  ageDays: 'AgeDays',
} as const;

export const BCF_DATASET_COLUMNS: ChartDatasetColumn[] = [
  { id: BCF_COLUMNS.status, label: 'Status', kind: 'category' },
  { id: BCF_COLUMNS.type, label: 'Type', kind: 'category' },
  { id: BCF_COLUMNS.priority, label: 'Priority', kind: 'category' },
  { id: BCF_COLUMNS.assignedTo, label: 'Assigned to', kind: 'category' },
  { id: BCF_COLUMNS.stage, label: 'Stage', kind: 'category' },
  { id: BCF_COLUMNS.labels, label: 'Labels', kind: 'category' },
  { id: BCF_COLUMNS.author, label: 'Author', kind: 'category' },
  { id: BCF_COLUMNS.due, label: 'Due (overdue / this week / later / none)', kind: 'category' },
  { id: BCF_COLUMNS.created, label: 'Created', kind: 'date' },
  { id: BCF_COLUMNS.modified, label: 'Modified', kind: 'date' },
  { id: BCF_COLUMNS.dueDate, label: 'Due date', kind: 'date' },
  { id: BCF_COLUMNS.closed, label: 'Closed', kind: 'date' },
  { id: BCF_COLUMNS.ageDays, label: 'Age', kind: 'number', unit: 'days' },
];

/** Statuses that count as closed: the BCF 2.1 universal `Closed` plus the spellings tools use for a terminal state. */
const CLOSED_STATUSES: ReadonlySet<string> = new Set(['closed', 'resolved', 'done']);

const MS_PER_DAY = 86_400_000;

function dueBucket(due: string | undefined, now: number): string {
  if (!due) return 'none';
  const t = Date.parse(due);
  if (!Number.isFinite(t)) return 'none';
  if (t < now) return 'overdue';
  if (t - now <= 7 * MS_PER_DAY) return 'this week';
  return 'later';
}

/** Renderer ids of every component any viewpoint of the topic selects, resolvable in the loaded models. */
export function topicElementIds(topic: BCFTopic, state: Pick<ViewerState, 'models' | 'ifcDataStore'>): number[] {
  const ids = new Set<number>();
  for (const viewpoint of topic.viewpoints) {
    for (const component of viewpoint.components?.selection ?? []) {
      if (!component.ifcGuid) continue;
      const hit = globalIdToExpressId(component.ifcGuid, state.models, state.ifcDataStore);
      if (hit) ids.add(hit.expressId);
    }
  }
  return [...ids];
}

export type BcfDatasetState = Pick<ViewerState, 'bcfProject' | 'models' | 'ifcDataStore'>;

export function buildBcfDataset(state: BcfDatasetState, now = Date.now()): ChartDataset {
  const project = state.bcfProject;
  const rows: ChartDatasetRow[] = [];
  let modifiedDigest = 0;
  if (project) {
    for (const topic of project.topics.values()) {
      const created = topic.creationDate ? Date.parse(topic.creationDate) : NaN;
      const closed = CLOSED_STATUSES.has((topic.topicStatus ?? '').toLowerCase()) ? (topic.modifiedDate ?? topic.creationDate ?? null) : null;
      const modified = topic.modifiedDate ? Date.parse(topic.modifiedDate) : NaN;
      if (Number.isFinite(modified)) modifiedDigest = (modifiedDigest * 31 + (modified / 1000)) % 1_000_000_007;
      rows.push({
        ids: topicElementIds(topic, state),
        values: [
          topic.topicStatus ?? '',
          topic.topicType ?? '',
          topic.priority ?? '',
          topic.assignedTo ?? '',
          topic.stage ?? '',
          topic.labels?.join(', ') ?? '',
          topic.creationAuthor ?? '',
          dueBucket(topic.dueDate, now),
          topic.creationDate ?? null,
          topic.modifiedDate ?? null,
          topic.dueDate ?? null,
          closed,
          Number.isFinite(created) ? Math.max(0, Math.round((now - created) / MS_PER_DAY)) : null,
        ],
      });
    }
  }
  return { source: 'bcf', columns: BCF_DATASET_COLUMNS, rows, fingerprint: `bcf:${project?.projectId ?? ''}:${rows.length}:${modifiedDigest}` };
}
