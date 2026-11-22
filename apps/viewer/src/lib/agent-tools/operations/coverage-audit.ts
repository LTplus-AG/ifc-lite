/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { VIEWER_COMMAND_SPECS } from '../viewer-command-tools';
import type { WorkspacePanelId } from '@/lib/panels/registry';
export type AuditFamily = 'core' | 'authoring' | 'clash' | 'analytics' | 'appearance' | 'coordination';
/** Explicit current-control audits, never inferred from an operation count.
 * Adding a panel requires an audit entry and concrete classified bindings. */
export const panelControlAudits: Readonly<Record<WorkspacePanelId, readonly AuditFamily[]>> = {
  hierarchy: ['core'], properties: ['core', 'authoring', 'coordination'], layers: ['coordination'], zones: ['authoring'],
  model: ['authoring'], placement: ['authoring'], changes: ['authoring', 'core'], changeSets: ['authoring'],
  clash: ['clash'], validation: ['authoring'], idsStudio: ['authoring'], compare: ['coordination'], bcf: ['coordination'],
  review: ['coordination'], collab: ['coordination'], lists: ['analytics'], charts: ['analytics'], gantt: ['analytics'],
  cost: ['analytics'], lens: ['analytics'], appearance: ['analytics', 'appearance'], environment: ['analytics'],
  drawing: ['analytics'], measurements: ['analytics'], presentation: ['analytics'], document: ['analytics', 'coordination'],
  pointclouds: ['analytics'], sources: ['coordination'], loadReport: ['coordination'], influx: ['coordination'],
  semantic: ['coordination'], flow: ['coordination'], script: ['coordination'], extensions: ['coordination'], assistant: ['coordination'],
};
export interface ToolControlAudit { controls: string; operations: readonly string[]; native_tools?: readonly (keyof typeof VIEWER_COMMAND_SPECS)[]; notes?: string }
const authoring: ToolControlAudit = {
  controls: 'Numerical native authoring, detached preview/apply/discard, dimensions/profiles/defaults and exact transaction/Undo',
  operations: ['authoring.describe', 'authoring.prepare', 'authoring.apply', 'authoring.discard', 'authoring.defaults.read', 'authoring.graphs.describe', 'authoring.nativeEvidence', 'authoring.room.prepare', 'authoring.graph.apply'],
  notes: 'Native proposal/graph codecs expose supported kinds and algorithm refusals. Pointer drawing/drag ghosts are presentation equivalents of the numerical inputs.',
};
/** Audited finite tools. A new registered tool stays an explicit gap until mapped. */
export const toolControlAudits: Readonly<Record<string, ToolControlAudit>> = {
  ...Object.fromEntries(['wall', 'slab', 'roof', 'column', 'beam', 'room', 'space-envelope', 'curtain-wall', 'grid', 'opening', 'door', 'window', 'split', 'stair', 'railing', 'split-multi', 'push-pull', 'align', 'trim-extend', 'array', 'move', 'rotate'].map(id => [id, authoring])),
  select: { controls: 'Native point/ray picking, model-qualified selection, view/visibility and basket actions', operations: ['viewport.pick', 'viewport.raycast', 'selection.read', 'selection.replace', 'selection.clear', 'camera.read', 'camera.set', 'camera.frame', 'visibility.hide', 'visibility.isolate', 'basket.replace'] },
  measure: { controls: 'Numerical point/distance/polyline/radius/three-point/edge/face angles, readouts, reference, snap/mode/geographic settings', operations: ['measurements.read', 'measurements.distance', 'measurements.polyline', 'measurements.radius', 'measurements.angle', 'measurements.angleEdges', 'measurements.angleFaces', 'measurements.placePoint', 'measurements.settings', 'measurements.configure', 'measurements.readouts'], notes: 'Pointer hover/edge-lock feedback is presentation state.' },
  section: { controls: 'Cardinal/face/box cuts, named plane library, cap appearance and native Undo', operations: ['section.read', 'section.replace', 'section.add', 'section.remove', 'section.nativeState', 'section.box', 'section.facePlane', 'section.customDistance', 'section.managePlane', 'section.capStyle', 'section.display', 'section.history'] },
  annotate: { controls: 'Numerical pin placement with entity anchors, note edits, deletion and selection', operations: ['annotations.read', 'annotations.create', 'annotations.createAnchored', 'annotations.manage'], notes: 'Existing in-progress human drafts are preserved; numerical creation replaces the pointer-placement gesture.' },
  walk: { controls: 'Native navigation activation and numerical camera/view-path equivalents', operations: ['camera.read', 'camera.set', 'presentation.play', 'presentation.stop'], native_tools: ['viewer_commands', 'viewer_command_run'], notes: 'Held-key and pointer motion are presentation gestures; numerical poses and timed view paths expose their scene effects.' },
  command: { controls: 'Live palette discovery and native command invocation with current prerequisites', operations: [], native_tools: ['viewer_commands', 'viewer_command_run'] },
  'polygon-area': { controls: 'Native 2D polygon-area markup by numerical vertices, listed with the other markups', operations: ['drawing.addPolygon', 'drawing.markups'] },
  cloud: { controls: 'Native 2D revision-cloud markup by numerical corners', operations: ['drawing.addCloud', 'drawing.markups'] },
  text: { controls: 'Native 2D text markup and its typography edits', operations: ['drawing.addText', 'drawing.styleText', 'drawing.markups'] },
  'appearance-face': { controls: 'Face-mask picking for an appearance candidate by explicit triangle ordinals', operations: ['appearance.faces.inspect', 'appearance.faces.prepare'] },
  'cesium-placement': { controls: 'Native numerical placement/georeference and EPSG/re-alignment workflows', operations: ['georeferencing.read', 'georeference.lookupEpsg', 'georeference.realignmentState', 'georeference.realign', 'placement.read', 'placement.translation.preview', 'placement.translation.action', 'placement.rotation'], native_tools: ['viewer_commands', 'viewer_command_run'], notes: 'Map pointer gestures have numerical placement/georeference equivalents; source reload/terrain refusals remain native.' },
};
