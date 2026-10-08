/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BCFTopic } from '@ifc-lite/bcf';
import { evidenceRow, take, unavailableCapture, type EvidenceAdapter } from './types';

const GUID_SAMPLE = 10;
const DESCRIPTION_BOUND = 400;
/** Topics without a status are counted under this key, never under a guessed one. */
const NO_STATUS = '(none)';

/** Distinct IFC GlobalIds the topic's viewpoints select. Authoring-tool ids without a GlobalId are not counted. */
function selectedGuids(topic: BCFTopic): Set<string> {
  const guids = new Set<string>();
  for (const viewpoint of topic.viewpoints) {
    for (const component of viewpoint.components?.selection ?? []) if (component.ifcGuid) guids.add(component.ifcGuid);
  }
  return guids;
}

/**
 * The loaded BCF project's topics. Only markup metadata and counts travel:
 * snapshots, viewpoint images, comment bodies and any server connection
 * details are never read.
 */
export const bcfAdapter: EvidenceAdapter = {
  id: 'bcf', group: 'checks', panelIds: ['bcf'],
  titleKey: 'bcf.panel.title', descriptionKey: 'assistantSources.bcf.description',
  rowMeaningKey: 'assistantSources.bcf.rows', unavailableKey: 'assistantSources.bcf.unavailable',
  suggestionKeys: ['assistantSources.bcf.suggestSummary', 'assistantSources.bcf.suggestPriorities'],
  readiness: s => s.bcfProject
    ? { status: { labelKey: 'assistantSources.bcf.pickTopics', params: { count: s.bcfProject.topics.size } }, ready: true }
    : { status: { labelKey: 'assistantSources.bcf.pickNone' }, ready: false },
  identity: s => s.bcfProject,
  capture: (s, limit) => {
    const project = s.bcfProject;
    if (!project) return unavailableCapture();
    const byStatus: Record<string, number> = {};
    for (const topic of project.topics.values()) {
      const status = topic.topicStatus || NO_STATUS;
      byStatus[status] = (byStatus[status] ?? 0) + 1;
    }
    const rows = take(project.topics.values(), limit).map(topic => {
      const guids = selectedGuids(topic);
      const description = topic.description;
      return evidenceRow({ kind: 'bcfTopic', status: topic.topicStatus ?? null }, {
        guid: topic.guid, title: topic.title, topicType: topic.topicType ?? null, priority: topic.priority ?? null,
        assignedTo: topic.assignedTo ?? null, labels: topic.labels ?? [], stage: topic.stage ?? null,
        dueDate: topic.dueDate ?? null, creationDate: topic.creationDate ?? null, modifiedDate: topic.modifiedDate ?? null,
        description: description && description.length > DESCRIPTION_BOUND ? `${description.slice(0, DESCRIPTION_BOUND)}…` : description ?? null,
        commentCount: topic.comments.length, viewpointCount: topic.viewpoints.length,
        ifcGuids: [...take(guids, GUID_SAMPLE)], ifcGuidCount: guids.size,
      });
    });
    return {
      summary: {
        kind: 'bcf-project', projectName: project.name ?? null, projectId: project.projectId ?? null, bcfVersion: project.version,
        topicCount: project.topics.size, topicsByStatus: byStatus, noStatusKey: NO_STATUS,
        units: { commentCount: 'comments', viewpointCount: 'viewpoints', ifcGuidCount: 'distinct selected IFC GlobalIds' },
        limitations: 'Topics are coordination markup written by people or tools; a status is what the topic says, not a verified state of the model. ifcGuids are the GlobalIds selected in the topic viewpoints (at most 10 listed per topic) and are not checked against the loaded models. Comment text, snapshots and viewpoint images are not included.',
      },
      rows, totalRows: project.topics.size, availability: 'available',
    };
  },
};
