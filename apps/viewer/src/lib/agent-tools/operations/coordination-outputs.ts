/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
const object = { type: 'object', additionalProperties: true };
const array = { type: 'array', items: {} };
const string = { type: 'string' };
const number = { type: 'number' };
const boolean = { type: 'boolean' };
const nullable = {};
const fields: Record<string, Record<string, unknown>> = {
  'compare.read': { base_model_id: nullable, head_model_id: nullable, scope: string, excluded_types: array, match_by_content: boolean, running: boolean, error: nullable, result: nullable },
  'compare.analyze': { baseModelId: string, headModelId: string, baseName: string, headName: string, scope: string, geometryUnavailable: boolean, diff: object },
  'bcf.read': { project: nullable, author: string, active_topic_id: nullable, overlay: boolean },
  'bcf.createProject': { project_id: string }, 'bcf.createTopic': { guid: string, title: string, creationAuthor: string, comments: array, viewpoints: array },
  'bcf.import': { topics: number },
  'bcf.updateTopic': { guid: string, title: string, modifiedDate: string }, 'bcf.updateComment': { topic_id: string, comment_id: string, comment: string }, 'bcf.deleteComment': { deleted: string },
  'bcf.comment': { guid: string, author: string, comment: string, date: string }, 'bcf.deleteTopic': { deleted: string },
  'bcf.selectTopic': { guid: string, title: string }, 'bcf.overlay': { visible: boolean }, 'bcf.author': { author: string },
  'review.read': { cards: array, totals: object, runs: array, failed: array, workspace: object, facets: object },
  'review.filter': { cards: array, totals: object, failed: array },
  'review.draftTopics': { saved: boolean }, 'review.createReport': { id: string, saved: boolean },
  'layers.read': { layers: array, diff: nullable, busy: boolean }, 'layers.contribution': { layer_id: string, diff: nullable },
  'loadReport.read': { reports: array },
  'semantic.read': { graph: string, graph_format: string, findings: array, profile: object, data_version: number, revisions: array, strategy: string },
  'semantic.graphFormat': { graph_format: string, data_version: number }, 'semantic.bindRevision': { revisions: array },
  'semantic.graph': { data_version: number }, 'semantic.validate': { graph: string, findings: array },
  'semantic.restoreWorkspace': { restored: boolean, data_version: number },
  'influx.read': { configuration: object, targets: array }, 'influx.query': { readings: object, joined: object },
  'flow.read': { saved: array, active_id: nullable, document: nullable, running: boolean, result: nullable, error: nullable, warnings: array, progress: nullable },
  'flow.analyze': { result: object },
  'flow.validate': { wiring: array, availability: array }, 'flow.open': { active_id: nullable }, 'flow.create': { id: string }, 'flow.save': { active_id: nullable, dirty: boolean },
  'flow.import': { id: string }, 'flow.delete': { deleted: string },
  'flow.cancel': { cancellation_requested: boolean, terminal: boolean },
  'script.read': { saved: array, active_id: nullable, source: string, revision: number, execution_state: string, result: nullable, error: nullable, diagnostics: array },
  'script.create': { id: string, storage: object }, 'script.open': { active_id: nullable, revision: number }, 'script.rename': { id: string, name: string, storage: nullable }, 'script.delete': { deleted: string, storage: object },
  'script.preflight': { diagnostics: array }, 'script.replace': { ok: boolean, appliedOpIds: array, revision: number }, 'script.save': { active_id: nullable, dirty: boolean, storage: nullable },
  'collab.read': { status: string, room_id: nullable, role: nullable, peers: array, connecting: boolean, seed_phase: string, seed_progress: nullable, seed_failure: nullable, geometry_notice: nullable },
  'collab.leave': { status: string }, 'assistant.read': { messages: array, status: string, model: string, error: nullable, auto_execute: boolean, usage: nullable },
  'assistant.cancel': { cancellation_requested: boolean, terminal: boolean }, 'assistant.model': { model: string },
  'sources.read': { providers: array, failures: array, source_tags: array }, 'sources.browse': { kind: string, page: object },
  'extensions.read': { installed: array }, 'extensions.flows': { contributions: object }, 'extensions.previewBundle': { validation: object },
};
const artifact = { artifact_id: string, filename: string, mime_type: string, bytes: number };
export function coordinationOutputSchema(id: string): Record<string, unknown> {
  const properties = id.endsWith('.export') || id === 'semantic.exportWorkspace' ? artifact : fields[id];
  if (!properties) throw new Error(`Missing coordination output contract: ${id}`);
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: true };
}
