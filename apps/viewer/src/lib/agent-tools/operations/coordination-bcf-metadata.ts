/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { BCFProject, BCFTopic, BCFComment, BCFViewpoint } from '@ifc-lite/bcf';
import { requirePageRevision, type PageRequest } from './result-limit';
import { stateRevision } from './state-revision';

/** Metadata responses stay well below the executor ceiling; media remains in native state and ZIP artifacts. */
const PAGE_BYTES = 192 * 1024;
export function bcfPage<T, U>(rows: readonly T[] | ReadonlyMap<string, T>, request: PageRequest, limit: number, metadata: (row: T) => U) {
  const offset = request.offset ?? 0;
  const values = () => rows.values();
  const rowRevisions: string[] = [];
  for (const row of values()) rowRevisions.push(stateRevision(metadata(row)));
  const total = rowRevisions.length;
  const page_revision = stateRevision(rowRevisions);
  requirePageRevision(offset, request.page_revision, page_revision);
  const items: U[] = []; let index = 0, bytes = 0;
  for (const row of values()) {
    if (index++ < offset) continue; if (items.length >= limit) break;
    const item = metadata(row), size = new TextEncoder().encode(JSON.stringify(item)).byteLength;
    if (bytes + size > PAGE_BYTES) { if (!items.length) throw new Error('Native BCF metadata exceeds the bounded page budget.'); break; }
    items.push(item); bytes += size;
  }
  const next = offset + items.length;
  return { items, page: { offset, requested_limit: limit, returned: items.length, total, page_revision, next_offset: next < total ? next : null, media_bodies_included: false } };
}
const text = (value: string | undefined, max = 2000) => value?.slice(0, max) ?? null;
export function bcfProjectMetadata(project: BCFProject) {
  let comments = 0, viewpoints = 0, snapshots = 0;
  for (const topic of project.topics.values()) { comments += topic.comments.length; viewpoints += topic.viewpoints.length; for (const viewpoint of topic.viewpoints) if (viewpoint.snapshot || viewpoint.snapshotData?.length) snapshots++; }
  return { version: project.version, projectId: project.projectId ?? null, name: text(project.name), topic_count: project.topics.size, comment_count: comments, viewpoint_count: viewpoints, snapshot_count: snapshots,
    extension_counts: { topicTypes: project.extensions?.topicTypes?.length ?? 0, topicStatuses: project.extensions?.topicStatuses?.length ?? 0, priorities: project.extensions?.priorities?.length ?? 0, topicLabels: project.extensions?.topicLabels?.length ?? 0, users: project.extensions?.users?.length ?? 0, stages: project.extensions?.stages?.length ?? 0 } };
}
export function bcfTopicMetadata(topic: BCFTopic) {
  const expected = topic.modifiedDate ?? topic.creationDate ?? '';
  return { guid: topic.guid, title: text(topic.title), description: text(topic.description, 10000), topicType: text(topic.topicType), topicStatus: text(topic.topicStatus), priority: text(topic.priority), index: topic.index ?? null,
    creationDate: text(topic.creationDate), creationAuthor: text(topic.creationAuthor), modifiedDate: text(topic.modifiedDate), modifiedAuthor: text(topic.modifiedAuthor), dueDate: text(topic.dueDate), assignedTo: text(topic.assignedTo), stage: text(topic.stage),
    expected_modified: expected.length <= 100 ? expected : null, title_complete: topic.title.length <= 2000, description_complete: (topic.description?.length ?? 0) <= 10000,
    comment_count: topic.comments.length, viewpoint_count: topic.viewpoints.length, label_count: topic.labels?.length ?? 0, header_count: topic.header?.length ?? 0, document_reference_count: topic.documentReferences?.length ?? 0, related_topic_count: topic.relatedTopics?.length ?? 0, bim_snippet_available: !!topic.bimSnippet };
}
export function bcfCommentMetadata(comment: BCFComment) {
  const complete = comment.comment.length <= 10000;
  return { guid: comment.guid, date: text(comment.date), author: text(comment.author), modifiedDate: text(comment.modifiedDate), modifiedAuthor: text(comment.modifiedAuthor), viewpointGuid: comment.viewpointGuid ?? null,
    comment: comment.comment.slice(0, 10000), text_complete: complete, total_text_chars: comment.comment.length, expected_comment: complete ? comment.comment : null };
}
export function bcfViewpointMetadata(viewpoint: BCFViewpoint) {
  return { guid: viewpoint.guid, perspectiveCamera: viewpoint.perspectiveCamera ?? null, orthogonalCamera: viewpoint.orthogonalCamera ?? null,
    line_count: viewpoint.lines?.length ?? 0, clipping_plane_count: viewpoint.clippingPlanes?.length ?? 0, bitmap_count: viewpoint.bitmaps?.length ?? 0,
    snapshot_available: !!(viewpoint.snapshot || viewpoint.snapshotData?.length), snapshot_data_bytes: viewpoint.snapshotData?.byteLength ?? 0, snapshot_text_chars: viewpoint.snapshot?.length ?? 0,
    snapshot_reference: viewpoint.snapshot && !viewpoint.snapshot.startsWith('data:') ? text(viewpoint.snapshot, 500) : null,
    selection_count: viewpoint.components?.selection?.length ?? 0, visibility_exception_count: viewpoint.components?.visibility?.exceptions?.length ?? 0,
    default_visibility: viewpoint.components?.visibility?.defaultVisibility ?? null, color_group_count: viewpoint.components?.coloring?.length ?? 0,
    colored_component_count: viewpoint.components?.coloring?.reduce((count, group) => count + group.components.length, 0) ?? 0 };
}
