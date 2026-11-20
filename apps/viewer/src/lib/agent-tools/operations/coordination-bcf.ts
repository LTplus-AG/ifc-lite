/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { emptySchema } from './contract';
import { bcfPage, bcfProjectMetadata, bcfTopicMetadata } from './coordination-bcf-metadata';
import { coordination, idSchema, textSchema, boolSchema } from './coordination-common';
function project() { const p = useViewerStore.getState().bcfProject; if (!p) throw new Error('Create or import a BCF project first.'); return p; }
function topic(id: string) { const t = project().topics.get(id); if (!t) throw new Error('BCF topic does not exist.'); return t; }
export const coordinationBcfOperations = [
  coordination<{ offset?: number; limit?: number; topic_id?: string }>('bcf.read', 'Read bounded native project/topic metadata. Defaults to 20 topics with a 192 KiB page budget; use next_offset or topic_id, and bcf.comments/bcf.viewpoints for child pages. Screenshot/media bodies stay in native state for application and ZIP export. expected_modified is the exact native optimistic edit guard.', ['read'], {
    type: 'object', properties: { offset: { type: 'integer', nullable: true, minimum: 0 }, limit: { type: 'integer', nullable: true, minimum: 1, maximum: 20 }, topic_id: { type: 'string', nullable: true, minLength: 1, maxLength: 200 } }, required: [], additionalProperties: false,
  }, i => {
    const s = useViewerStore.getState(), p = s.bcfProject, selected = i.topic_id ? p?.topics.get(i.topic_id) : undefined;
    if (i.topic_id && !selected) throw new Error('BCF topic does not exist.');
    const rows = selected ? [selected] : p?.topics.values() ?? [], total = selected ? 1 : p?.topics.size ?? 0;
    const page = bcfPage(rows, total, i.offset ?? 0, i.limit ?? 20, bcfTopicMetadata);
    return { project: p ? { ...bcfProjectMetadata(p), topics: page.items } : null, page: page.page, author: s.bcfAuthor.slice(0, 2000), author_complete: s.bcfAuthor.length <= 2000, active_topic_id: s.activeTopicId, overlay: s.bcfOverlayVisible };
  }),
  coordination('bcf.createProject', 'Create an empty local BCF project. Refuses to replace an existing project.', ['configuration'], textSchema, async (i, c) => {
    if (useViewerStore.getState().bcfProject) throw new Error('A BCF project is already open. Export or clear it in the BCF workspace before replacing it.');
    const { createBCFProject } = await import('@ifc-lite/bcf'); const p = createBCFProject({ name: i.value }); return c.commit(() => { if (useViewerStore.getState().bcfProject) throw new Error('A BCF project was opened during creation.'); useViewerStore.getState().setBcfProject(p); return { project_id: p.projectId }; });
  }),
  coordination<{ title: string; description: string; status: string }>('bcf.createTopic', 'Create a local issue using the native BCF topic factory. Does not publish remotely.', ['configuration'], {
    type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 500 }, description: { type: 'string', maxLength: 10000 }, status: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['title', 'description', 'status'], additionalProperties: false,
  }, async (i: { title: string; description: string; status: string }, c) => {
    const previousProject = project(); const { createBCFTopic } = await import('@ifc-lite/bcf');
    const s = useViewerStore.getState(); const t = createBCFTopic({ title: i.title, description: i.description, topicStatus: i.status, author: s.bcfAuthor }); return c.commit(() => { if (project() !== previousProject) throw new Error('BCF project changed during topic creation.'); s.addTopic(t); return bcfTopicMetadata(t); });
  }),
  coordination<{ id: string; comment: string }>('bcf.comment', 'Add a comment to an existing local BCF topic.', ['configuration'], {
    type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 200 }, comment: { type: 'string', minLength: 1, maxLength: 10000 } }, required: ['id', 'comment'], additionalProperties: false,
  }, async (i: { id: string; comment: string }, c) => {
    const previousProject = project(); topic(i.id); const { createBCFComment } = await import('@ifc-lite/bcf'); const s = useViewerStore.getState(); const comment = createBCFComment({ author: s.bcfAuthor, comment: i.comment }); return c.commit(() => { if (project() !== previousProject) throw new Error('BCF project changed during comment creation.'); topic(i.id); s.addComment(i.id, comment); return comment; });
  }),
  coordination('bcf.deleteTopic', 'Delete one local topic using the native deletion contract.', ['configuration'], idSchema, (i, c) => c.commit(() => { topic(i.id); useViewerStore.getState().deleteTopic(i.id); return { deleted: i.id }; })),
  coordination('bcf.selectTopic', 'Select a known BCF topic for inspection.', ['view'], idSchema, (i, c) => c.commit(() => { const t = topic(i.id); useViewerStore.getState().setActiveTopic(i.id); return bcfTopicMetadata(t); })),
  coordination('bcf.overlay', 'Set native BCF viewpoint markers visibility.', ['view'], boolSchema, (i, c) => c.commit(() => { useViewerStore.getState().setBcfOverlayVisible(i.value); return { visible: i.value }; })),
  coordination('bcf.author', 'Set the local author used for subsequent topics and comments.', ['configuration'], textSchema, (i, c) => c.commit(() => { useViewerStore.getState().setBcfAuthor(i.value); return { author: i.value }; })),
  coordination<{ id: string; expected_modified: string; title: string; description: string; status: string; priority: string; assigned_to: string }>('bcf.updateTopic', 'Update local topic fields with an optimistic modification-date guard.', ['configuration'], {
    type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 200 }, expected_modified: { type: 'string', maxLength: 100 }, title: { type: 'string', minLength: 1, maxLength: 500 }, description: { type: 'string', maxLength: 10000 }, status: { type: 'string', minLength: 1, maxLength: 100 }, priority: { type: 'string', maxLength: 100 }, assigned_to: { type: 'string', maxLength: 500 } }, required: ['id', 'expected_modified', 'title', 'description', 'status', 'priority', 'assigned_to'], additionalProperties: false,
  }, (i, c) => c.commit(() => {
    const t = topic(i.id); if ((t.modifiedDate ?? t.creationDate ?? '') !== i.expected_modified) throw new Error('BCF topic changed; refresh before updating.');
    const state = useViewerStore.getState(); state.updateTopic(i.id, { title: i.title, description: i.description, topicStatus: i.status, priority: i.priority, assignedTo: i.assigned_to, modifiedDate: new Date().toISOString(), modifiedAuthor: state.bcfAuthor });
    return bcfTopicMetadata(topic(i.id));
  })),
  coordination<{ topic_id: string; comment_id: string; expected_comment: string; comment: string }>('bcf.updateComment', 'Edit a local BCF comment only if its current text still matches the inspected value.', ['configuration'], {
    type: 'object', properties: { topic_id: { type: 'string', minLength: 1, maxLength: 200 }, comment_id: { type: 'string', minLength: 1, maxLength: 200 }, expected_comment: { type: 'string', maxLength: 1000000 }, comment: { type: 'string', minLength: 1, maxLength: 10000 } }, required: ['topic_id', 'comment_id', 'expected_comment', 'comment'], additionalProperties: false,
  }, (i, c) => c.commit(() => {
    const t = topic(i.topic_id), comment = t.comments.find(comment => comment.guid === i.comment_id);
    if (!comment || comment.comment !== i.expected_comment) throw new Error('BCF comment changed or no longer exists.');
    useViewerStore.getState().updateComment(i.topic_id, i.comment_id, { comment: i.comment, modifiedDate: new Date().toISOString(), modifiedAuthor: useViewerStore.getState().bcfAuthor });
    return { topic_id: i.topic_id, comment_id: i.comment_id, comment: i.comment };
  })),
  coordination<{ topic_id: string; comment_id: string; expected_comment: string }>('bcf.deleteComment', 'Delete one inspected local comment using the native deletion contract and an expected-text guard.', ['configuration'], {
    type: 'object', properties: { topic_id: { type: 'string', minLength: 1, maxLength: 200 }, comment_id: { type: 'string', minLength: 1, maxLength: 200 }, expected_comment: { type: 'string', maxLength: 1000000 } }, required: ['topic_id', 'comment_id', 'expected_comment'], additionalProperties: false,
  }, (i, c) => c.commit(() => {
    const comment = topic(i.topic_id).comments.find(comment => comment.guid === i.comment_id);
    if (!comment || comment.comment !== i.expected_comment) throw new Error('BCF comment changed or no longer exists.');
    useViewerStore.getState().deleteComment(i.topic_id, i.comment_id); return { deleted: i.comment_id };
  })),
  coordination<{ base64: string; replace_project_id: string }>('bcf.import', 'Read a bounded BCF ZIP using the native archive safety checks. Requires the exact current project id (or empty for no project) before replacing local state.', ['configuration'], {
    type: 'object', properties: { base64: { type: 'string', minLength: 1, maxLength: 1000000 }, replace_project_id: { type: 'string', maxLength: 200 } }, required: ['base64', 'replace_project_id'], additionalProperties: false,
  }, async (i, c) => {
    const before = useViewerStore.getState().bcfProject;
    if ((before?.projectId ?? '') !== i.replace_project_id) throw new Error('BCF project changed; inspect before importing.');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(i.base64)) throw new Error('Expected base64 BCF ZIP bytes.');
    const { readBCF } = await import('@ifc-lite/bcf'); const bytes = Uint8Array.from(atob(i.base64), character => character.charCodeAt(0));
    const imported = await readBCF(bytes); c.checkpoint?.();
    return c.commit(() => {
      if (useViewerStore.getState().bcfProject !== before) throw new Error('BCF project changed during import.');
      useViewerStore.getState().setBcfProject(imported); return { project_id: imported.projectId, topics: imported.topics.size };
    });
  }),
  coordination('bcf.export', 'Write the complete native BCF project, including all stored screenshots and media, through the native ZIP writer into a host-owned artifact.', ['artifact'], emptySchema, async (_, c) => {
    const p = project(); const { writeBCF } = await import('@ifc-lite/bcf');
    const blob = await writeBCF(p); c.checkpoint?.(); if (useViewerStore.getState().bcfProject !== p) throw new Error('BCF project changed during export.');
    return c.artifacts.create({ filename: 'coordination.bcf', mimeType: 'application/octet-stream', data: blob });
  }),
];
