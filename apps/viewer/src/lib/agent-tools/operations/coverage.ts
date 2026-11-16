/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WorkspacePanelId } from '@/lib/panels/registry';
import { TOOL_FEATURE, toolFeatureRows } from '@/lib/features/tools';
import { viewerOperations } from './registry';

/** Remaining migration work is a gap, never a fabricated human-only restriction. */
export const PANEL_OPERATION_GAPS = {
  hierarchy: ['Traverse/filter tree, storey display, memberships and contextual actions.'],
  properties: ['Inspect/edit attribute/property/classification controls through existing reviewed edit tools; not migrated to operation registry.'],
  layers: ['Layer traversal, ordering, visibility, composition and diff workflows.'],
  zones: ['Inspect/create/update/delete zones and memberships.'],
  model: ['All native authoring/hosted-element/storey/group/constraint/join transactions and preview/apply/undo.'],
  placement: ['Numerical placement/georeferencing, transforms, previews and native undo.'],
  changes: ['Inspect/review/select/revert changes and native undo/redo.'],
  changeSets: ['Inspect/compose/review/apply change sets with exact candidate approval.'],
  clash: ['Panel settings, preset/exclusion/review editing, native report publication/focus/BCF export, duplicates, cross-model analysis.'],
  validation: ['Rule-based checks, panel settings, findings presentation, saved reports, fixes and report export.'],
  idsStudio: ['Document authoring, facet edits, lint, validation workflow and IDS/IDSZ exports.'],
  compare: ['Select revisions, configure/run/cancel comparison, inspect/visualize differences and exports.'],
  bcf: ['Topic/comment/viewpoint edits, imports/exports and reviewed remote publication.'],
  review: ['Capture/reconcile findings, review artifacts, comments and reviewed publication.'],
  collab: ['Inspect roster/roles/session, room join/leave and native collaboration workflows.'],
  lists: ['Query/columns/grouping/filtering, saving configurations and result exports.'],
  charts: ['Define/evaluate charts, focus buckets, save dashboards and export results.'],
  gantt: ['Schedule import/edit/dependencies, playback, saving configurations and exports.'],
  cost: ['Cost graph editing/evaluation, configuration and exports; existing cost_evaluate remains available separately.'],
  lens: ['Rule authoring/evaluation, apply/reset native overlays and saved definitions.'],
  appearance: ['Material recipe/source editing, effective state inspection and recipe application.'],
  environment: ['Lighting presets, shadow resolution, solar location/date and analysis jobs.'],
  drawing: ['Configure/generate drawings, inspect results and observable artifact export.'],
  measurements: ['Numerical angle/radius/point measurements, individual polyline/angle/radius deletion, gesture settings and exports.'],
  presentation: ['Save/edit/apply views, tours, playback, capture and artifact export.'],
  document: ['Structured document/block editing, binding evaluation, rendering and artifact exports.'],
  pointclouds: ['Source/CRS/transforms, clipping/LOD, fixed color, sizing strategy, deviation/alignment jobs and exports.'],
  sources: ['Provider/source lifecycle, canonical loading, cancellation and diagnostics.'],
  loadReport: ['Load report traversal, diagnostic selection/filtering and exports.'],
  influx: ['Linked time-series configuration, bounded queries, analysis and host credential grants.'],
  semantic: ['Linked record/entity operations, graph exploration and native capability gating.'],
  flow: ['Graph authoring/validation/run/cancel/results, native capability review and artifacts.'],
  script: ['Script artifact authoring, sandbox execution/cancellation/results with per-script capabilities.'],
  extensions: ['Extension capability discovery/install/remove/lifecycle with host review.'],
  assistant: ['Context/artifact access, request lifecycle and configured assistant execution.'],
} as const satisfies Record<WorkspacePanelId, readonly string[]>;

const TOOL_IMPLEMENTATIONS: Readonly<Record<string, readonly string[]>> = {
  select: ['selection.read', 'selection.replace', 'selection.clear', 'camera.read', 'camera.set', 'camera.frame'],
  measure: ['measurements.read', 'measurements.distance', 'measurements.polyline', 'measurements.reference', 'measurements.clearReference'],
  section: ['section.read', 'section.replace', 'section.add', 'section.remove'],
};
export function viewerOperationCoverage() {
  const operations = viewerOperations();
  const toolIds = [...new Set(['select', 'cesium-placement', 'command', ...Object.keys(TOOL_FEATURE), ...Object.keys(toolFeatureRows(''))])];
  return {
    version: 1, complete: false, panel_count: Object.keys(PANEL_OPERATION_GAPS).length, operation_count: operations.length,
    panels: Object.entries(PANEL_OPERATION_GAPS).map(([id, gaps]) => ({
      id, complete: false, implemented: operations.filter(operation => operation.owner === id).map(operation => operation.id), gaps,
    })),
    tools: toolIds.map(id => ({ id, complete: false, implemented: TOOL_IMPLEMENTATIONS[id] ?? [],
      gaps: id === 'select' ? ['Surface/ray picking and walk navigation.']
        : id === 'section' ? ['Numerical section boxes and host-specific clipping controls.']
        : id === 'measure' ? ['Angle/radius/point modes and gesture settings.']
        : ['Parameterized equivalent of this native interactive tool has not been migrated.'],
    })),
    non_panel: [
      { id: 'preferences', complete: false, gaps: ['Theme, units, navigation, performance, shortcuts and layout settings.'] },
      { id: 'palette', complete: false, implemented: ['viewer_commands', 'viewer_command_run'], gaps: ['Parameterized forms and runtime contribution contracts.'] },
      { id: 'file-export', complete: false, gaps: ['Artifact handles and observable exports through native download helpers.'] },
      { id: 'contextual-entity', complete: false, implemented: ['selection.replace', 'visibility.hide', 'visibility.show', 'visibility.isolate'], gaps: ['Remaining native contextual authoring and linked-record actions.'] },
      { id: 'tours-mobile', complete: false, gaps: ['Tour lifecycle and mobile control settings.'] },
      { id: 'runtime-extensions', complete: false, gaps: ['Versioned contribution registration/removal and capability review.'] },
    ],
    human_only: [
      { id: 'browser-file-picker', reason: 'The browser requires a real user gesture for privileged local file selection.', action: 'Choose the file through the existing viewer picker.' },
      { id: 'provider-credentials', reason: 'Credentials and OAuth consent belong to the existing provider host.', action: 'Connect the provider using its native credential prompt.' },
      { id: 'publication-approval', reason: 'Existing native review authorizes a concrete publication candidate.', action: 'Approve that candidate in the existing publication review.' },
    ],
    limitations: ['No panel is claimed complete.', 'Active-tool store type is string; the finite tool list comes from the feature/authoring inventory plus baseline tools.',
      'Model writes, file/network effects and publication are deliberately outside this operation executor; existing reviewed edit tools and palette commands remain available.'],
  };
}
