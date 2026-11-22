/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { internal } from './refusals';

const object = { type: 'object', additionalProperties: true };
const array = { type: 'array', items: {} };
const string = { type: 'string' };
const number = { type: 'number' };
const boolean = { type: 'boolean' };
const nullable = {};
const fields: Record<string, Record<string, unknown>> = {
  'assistant.captureAttachments': { attachment_id: string, evidence_id: string, selection_count: number, screenshot: boolean, rooms: boolean }, 'assistant.removeAttachments': { removed: boolean },
  'compare.exportSidecar': { artifact_id: string, filename: string, mime_type: string, bytes: number }, 'compare.importSidecar': { refused: array, accepted: number, requires_rerun: boolean }, 'review.exportWorkspace': { artifact_id: string, filename: string, mime_type: string, bytes: number }, 'review.importWorkspace': { imported: number, storage: object },
  'bcf.editDraftMembers': { batch: object, saved: boolean }, 'bcf.reconcileDraft': { proposal: object, saved: boolean }, 'bcf.resolveOutbox': { saved: boolean, outcome: nullable }, 'bcf.connect': { saved: boolean, connection: object }, 'bcf.disconnect': { disconnected: boolean }, 'influx.configure': { saved: boolean, configuration: object }, 'layers.exportReview': { artifact_id: string, filename: string, mime_type: string, bytes: number }, 'layers.loadStack': { state: string, layers: array, model_ids: array },
  'extensions.enable': { state: string, extension_id: string }, 'extensions.runCommand': { state: string, extension_id: string, result: object }, 'extensions.runExporter': { state: string, extension_id: string, artifact: object, result: object }, 'extensions.flavors': { flavors: array, active_id: nullable }, 'extensions.createFlavor': { flavor: object }, 'extensions.editFlavor': { state: string, id: string }, 'extensions.switchFlavor': { state: string, id: string, unapplied: array }, 'extensions.exportFlavor': { artifact_id: string, filename: string, mime_type: string, bytes: number }, 'extensions.importFlavor': { flavor: object }, 'extensions.saveFlavorDefinition': { flavor: object }, 'extensions.resetFlavors': { flavor: object },
  'semantic.profileFromBsdd': { profile: object, diagnostics: array }, 'semantic.loadSource': { diagnostic: string, data_version: number }, 'semantic.endpoint': { endpoint: nullable, generation: number, configured: boolean }, 'semantic.profile': { profile: object, diagnostics: array }, 'semantic.profileArtifact': { artifact_id: string, filename: string, mime_type: string, bytes: number }, 'semantic.links': { links: array }, 'semantic.identity': { strategy: string, identity_fields: object, uri_config: object }, 'semantic.resolveResource': { resolution: object, related: array, selected: nullable }, 'semantic.prepareProjection': { plan_id: string, target: object, GlobalId: string, revision: nullable, property: string, previous: nullable, value: nullable, unit: nullable, policy: string, skip: boolean }, 'semantic.applyProjection': { applied: boolean, skipped: boolean, plan_id: string },
  'sources.favourites': { provider: string, favourites: array }, 'sources.toggleFavourite': { added: boolean, ok: boolean, items: array }, 'sources.renameFavourite': { items: array }, 'sources.removeFavourite': { removed: boolean, items: array }, 'sources.refreshRevisions': { updates: nullable, failures: array, unsupported_model_ids: array, partial: boolean },
  'collab.join': { state: string, room_id: string }, 'collab.identity': { name: string, color: string }, 'collab.prepareRoom': { state: string, candidate: object, seed_failure: nullable }, 'collab.revokeInvite': { revoked: boolean }, 'collab.removePeer': { removed: boolean },
  'layers.library': { layer_ids: array, refs: object, durability: string }, 'layers.publishLocalDraft': { state: string, mode: string, result: object, durability: string }, 'layers.previewLocalMerge': { outcome: object, checks: array, candidate_id: string, ref_json: string }, 'layers.mergeLocal': { outcome: object, durability: string }, 'layers.loadLocalRef': { loaded: number, ref_name: string }, 'layers.registry': { layers: array, refs: object, reviews: array }, 'layers.prepareRegistryAction': { state: string, candidate: object },
  'georeference.lookupEpsg': { results: array }, 'georeference.realignmentState': { model_ids: array, mutation_version: number, geometry_version: number, sources: array }, 'georeference.realign': { state: string, loaded: number, total: number, failed: array },
  'compare.saveReport': { id: string, saved: boolean }, 'compare.savedReports': { reports: array, storage: object }, 'compare.renameSavedReport': { id: string, saved: boolean }, 'compare.deleteSavedReport': { id: string, deleted: boolean }, 'compare.openSavedReport': { opened: string }, 'compare.identityDecision': { action: string, refused: array, accepted: array, rejected: array }, 'compare.captureRun': { id: string, kind: string }, 'compare.runs': { runs: array, reconciliation: nullable }, 'compare.reconcile': { outcome: object }, 'compare.removeRun': { removed: string },
  'compare.savedAnalysisRuns': { runs: array, storage: object }, 'compare.saveAnalysisRun': { saved: boolean }, 'compare.bindSavedAnalysisRun': { ok: boolean }, 'compare.deleteSavedAnalysisRun': { deleted: boolean, id: string },
  'compare.read': { base_model_id: nullable, head_model_id: nullable, scope: string, excluded_types: array, match_by_content: boolean, running: boolean, error: nullable, result: nullable },
  'compare.run': { baseModelId: string, headModelId: string, baseName: string, headName: string, scope: string, geometryUnavailable: boolean, diff: object }, 'compare.showUnchanged': { show_unchanged: boolean },
  'compare.analyze': { baseModelId: string, headModelId: string, baseName: string, headName: string, scope: string, geometryUnavailable: boolean, diff: object },
  'bcf.comments': { topic_id: string, comments: array, page: object }, 'bcf.viewpoints': { topic_id: string, viewpoints: array, page: object }, 'bcf.readText': { text: string, offset: number, total_chars: number, next_offset: nullable, page_revision: string }, 'bcf.projectExtensions': { kind: string, values: array, page: object },
  'bcf.server': { connection: nullable }, 'bcf.serverProjects': { projects: array }, 'bcf.pullProject': { project: object, warnings: array }, 'bcf.outbox': { publications: array }, 'bcf.preparePublication': { state: string, candidate: object }, 'bcf.publish': { state: string, candidate_id: string, digest: string },
  'bcf.drafts': { batches: array, storage: object }, 'bcf.editDraftTopic': { batch: object, saved: boolean }, 'bcf.addDraftComment': { batch: object, saved: boolean }, 'bcf.deleteDraftTopic': { batch: object, saved: boolean }, 'bcf.mergeDraftTopics': { batch: object, saved: boolean }, 'bcf.importDrafts': { imported: object, adopted: array },
  'bcf.read': { project: nullable, page: object, author: string, author_complete: boolean, active_topic_id: nullable, overlay: boolean },
  'bcf.createProject': { project_id: string }, 'bcf.createTopic': { guid: string, title: string, creationAuthor: nullable, comment_count: number, viewpoint_count: number },
  'bcf.captureViewpoint': { topic_id: string, viewpoint: object }, 'bcf.applyViewpoint': { applied: string }, 'bcf.deleteViewpoint': { deleted: string },
  'bcf.import': { topics: number },
  'bcf.updateTopic': { guid: string, title: string, modifiedDate: string }, 'bcf.updateComment': { topic_id: string, comment_id: string, comment: string }, 'bcf.deleteComment': { deleted: string },
  'bcf.comment': { guid: string, author: string, comment: string, date: string }, 'bcf.deleteTopic': { deleted: string },
  'bcf.selectTopic': { guid: string, title: string }, 'bcf.overlay': { visible: boolean }, 'bcf.author': { author: string },
  'review.read': { cards: array, totals: object, runs: array, failed: array, workspace: object, facets: object },
  'review.openOriginal': { opened: boolean, finding_id: string },
  'review.filter': { cards: array, totals: object, failed: array },
  'review.draftTopics': { saved: boolean }, 'review.createReport': { id: string, saved: boolean },
  'layers.read': { layers: array, diff: nullable, busy: boolean }, 'layers.contribution': { layer_id: string, diff: nullable },
  'loadReport.focusEntity': { selected: number, model_id: string, framing: string },
  'loadReport.read': { reports: array },
  'semantic.read': { graph: string, graph_format: string, findings: array, profile: object, data_version: number, revisions: array, strategy: string },
  'semantic.graphFormat': { graph_format: string, data_version: number }, 'semantic.bindRevision': { revisions: array },
  'semantic.graph': { data_version: number }, 'semantic.validate': { graph: string, findings: array },
  'semantic.restoreWorkspace': { restored: boolean, data_version: number },
  'influx.read': { configuration: object, targets: array }, 'influx.query': { readings: object, joined: object },
  'flow.artifacts': { artifacts: array },
  'flow.run': { state: string, result: nullable, error: nullable, checkpoint: nullable }, 'flow.review': { checkpoint: nullable, busy: boolean, problem: nullable }, 'flow.approveReview': { checkpoint: object }, 'flow.rejectReview': { checkpoint: object },
  'flow.read': { active_model_id: nullable, mutation_version: number, geometry_version: number, saved: array, active_id: nullable, document: nullable, running: boolean, result: nullable, error: nullable, warnings: array, progress: nullable },
  'flow.analyze': { result: object },
  'flow.validate': { wiring: array, availability: array }, 'flow.open': { active_id: nullable }, 'flow.create': { id: string }, 'flow.save': { active_id: nullable, dirty: boolean },
  'flow.replaceDocument': { id: string, dirty: boolean }, 'flow.serialize': { document_json: string },
  'flow.import': { id: string }, 'flow.delete': { deleted: string },
  'flow.cancel': { cancellation_requested: boolean, terminal: boolean },
  'script.execute': { state: string, result: nullable, error: nullable, diagnostics: array }, 'script.cancel': { cancellation_requested: boolean, terminal: boolean },
  'script.read': { saved: array, active_id: nullable, source: string, revision: number, execution_state: string, run_epoch: number, result: nullable, error: nullable, diagnostics: array },
  'script.undo': { changed: boolean, revision: number }, 'script.redo': { changed: boolean, revision: number },
  'script.analyze': { logs: array, durationMs: number },
  'script.create': { id: string, storage: object }, 'script.open': { active_id: nullable, revision: number }, 'script.rename': { id: string, name: string, storage: nullable }, 'script.delete': { deleted: string, storage: object },
  'script.preflight': { diagnostics: array }, 'script.replace': { ok: boolean, appliedOpIds: array, revision: number }, 'script.save': { active_id: nullable, dirty: boolean, storage: nullable },
  'collab.read': { status: string, room_id: nullable, role: nullable, peers: array, connecting: boolean, seed_phase: string, seed_progress: nullable, seed_failure: nullable, geometry_notice: nullable },
  'collab.leave': { status: string }, 'assistant.read': { messages: array, status: string, model: string, error: nullable, evidence_id: nullable, budget: object, output: string },
  'assistant.captureEvidence': { evidence_id: string, source: string }, 'assistant.send': { completed: boolean, status: string, error: nullable, messages: array, budget: object },
  'assistant.cancel': { cancellation_requested: boolean, terminal: boolean }, 'assistant.model': { model: string },
  'sources.configure': { provider: string, saved: boolean, configured: boolean }, 'sources.forgetPreferences': { provider: string, cleared: boolean }, 'sources.testConnection': { ok: boolean, message: string }, 'sources.signOut': { provider: string, signed_out: boolean },
  'sources.loadModel': { model_id: string, name: string, state: string, bytes: number },
  'sources.read': { providers: array, failures: array, source_tags: array }, 'sources.browse': { kind: string, page: object },
  'extensions.requestInstall': { state: string, extension_id: string, version: string }, 'extensions.disable': { extension_id: string, enabled: boolean }, 'extensions.uninstall': { removed: string },
  'extensions.read': { installed: array }, 'extensions.flows': { contributions: object }, 'extensions.previewBundle': { validation: object },
};
const artifact = { artifact_id: string, filename: string, mime_type: string, bytes: number };
export function coordinationOutputSchema(id: string): Record<string, unknown> {
  const properties = id.endsWith('.export') || (id === 'semantic.exportWorkspace' || id === 'flow.exportArtifact' || id === 'compare.exportReport' || id === 'bcf.exportDraft') ? artifact : fields[id];
  if (!properties) throw internal(`Missing coordination output contract: ${id}`);
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: true };
}
