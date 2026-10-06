/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF topics as coordination records. A topic's elements are the IfcGuids its
 * viewpoints select or colour; BCF names no model, so a GlobalId present in two
 * loaded models stays ambiguous. The topic status is the topic's own and is
 * never changed by the review workspace.
 */

import type { BCFProject, BCFTopic } from '@ifc-lite/bcf';
import type { FindingRun, FindingSourceResult, ReviewFinding } from '../types';

function topicGuids(topic: BCFTopic): string[] {
  const guids = new Set<string>();
  for (const viewpoint of topic.viewpoints) {
    const components = viewpoint.components;
    for (const component of components?.selection ?? []) if (component.ifcGuid) guids.add(component.ifcGuid);
    for (const coloring of components?.coloring ?? []) for (const component of coloring.components) if (component.ifcGuid) guids.add(component.ifcGuid);
  }
  return [...guids];
}

export function bcfFindings(project: BCFProject | null): FindingSourceResult {
  if (!project || project.topics.size === 0) return { runs: [], findings: [] };
  const run: FindingRun = { id: 'bcf:project', source: 'bcf', temporal: 'current', label: project.name || 'BCF',
    capturedAt: null, complete: true, incomplete: [], models: [] };
  const findings: ReviewFinding[] = [...project.topics.values()].map(topic => ({
    id: `${run.id}#${topic.guid}`, lineage: `bcf|${topic.guid}`, source: 'bcf', run,
    elements: topicGuids(topic).map(globalId => ({ globalId, modelId: null, modelName: null })),
    nativeStatus: topic.topicStatus ?? '', title: topic.title,
    detail: [topic.topicType, topic.priority ? `priority ${topic.priority}` : '', topic.assignedTo ? `assigned ${topic.assignedTo}` : '',
      topic.labels?.length ? `labels ${topic.labels.join(', ')}` : ''].filter((line): line is string => !!line),
    lifecycle: 'record', disciplines: [], storeys: [], evidence: { kind: 'bcf', topicGuid: topic.guid },
  }));
  return { runs: [run], findings };
}
