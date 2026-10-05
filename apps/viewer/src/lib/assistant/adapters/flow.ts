/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { evidenceJson } from '../projection';
import { unavailableCapture, type EvidenceAdapter } from './types';

/** Graph structure only: parameters, inputs/outputs and run state are excluded (see `flowRun`). */
export const flowAdapter: EvidenceAdapter = {
  id: 'flow', group: 'automation', panelIds: ['flow'],
  titleKey: 'flowPanel.title', descriptionKey: 'assistant.pickFlowDescription',
  rowMeaningKey: 'assistant.evidenceRowsFlow', unavailableKey: 'assistant.evidenceUnavailableFlow',
  suggestionKeys: ['assistant.suggestFlowExplain', 'assistant.suggestFlowPatch', 'flowAssistant.suggestCreate'],
  readiness: s => s.flowDoc
    ? { status: { labelKey: 'assistant.pickGraph', params: { name: s.flowDoc.name, count: s.flowDoc.nodes.length } }, ready: true }
    // A new graph can be described without one open (#6919): `flow.create` proposals.
    : { status: { labelKey: 'flowAssistant.pickCreate' }, ready: true },
  identity: s => s.flowDoc,
  capture: s => {
    const doc = s.flowDoc;
    if (!doc) return unavailableCapture();
    const graph = evidenceJson({ id: doc.id, name: doc.name, description: doc.description,
      nodes: doc.nodes.slice(0, 100).map(node => ({ id: node.id, type: node.type, label: node.label })),
      edges: doc.edges.slice(0, 100), nodeCount: doc.nodes.length, edgeCount: doc.edges.length,
      omitted: 'Node parameters and input/output values are excluded from this discussion snapshot' });
    const parsed: unknown = JSON.parse(graph.text);
    return { summary: { kind: 'graph-only', executionStatus: 'not included' }, rows: [{ graph: parsed, graphTruncated: graph.truncated }],
      totalRows: 1, availability: 'available' };
  },
};
