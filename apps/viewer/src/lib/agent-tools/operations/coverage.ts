/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TOOL_FEATURE, toolFeatureRows } from '@/lib/features/tools';
import { viewerOperations } from './registry';

import { clashControlBindings } from './clash-native-inventory';
import { coreControlInventory } from './core-inventory';
import { WORKSPACE_PANELS } from '@/lib/panels/registry';
import { analyticsControlInventory } from './analytics-inventory';
import { coordinationControlInventory } from './coordination-inventory';
import { authoringControlBindings } from './authoring-inventory';

/** Control inventory is data, separate from lazily loaded feature implementations. */
interface ControlInventory {
  owner: string;
  controls: readonly { control: string; operations: readonly string[]; status?: string; reason?: string }[];
  gaps: readonly string[];
}
export function operationControlInventory(): ControlInventory[] {
  return [
    ...coreControlInventory,
    ...clashControlBindings.map(row => ({ owner: 'clash', controls: [{ control: row.controls.join('; '), operations: row.operations,
      status: row.status, reason: 'boundary' in row ? row.boundary : undefined }], gaps: [] })),
    ...analyticsControlInventory.map(row => ({ owner: row.panel, controls: row.controls,
      gaps: [...row.pending] as readonly string[] })),
    ...coordinationControlInventory.map(row => ({ owner: row.owner,
      controls: [{ control: row.implemented.join('; '), operations: row.operations }], gaps: [...row.outstanding] as readonly string[] })),
    ...authoringControlBindings.map(row => ({ owner: row.owner === 'ids' ? 'idsStudio' : row.owner,
      controls: [{ control: row.controls.join('; '), operations: row.operations, status: row.status, reason: row.reason }],
      gaps: row.status === 'integration-gap' ? row.controls : [] })),
  ];
}

const TOOL_IMPLEMENTATIONS: Readonly<Record<string, readonly string[]>> = {
  select: ['selection.read', 'selection.replace', 'selection.clear', 'camera.read', 'camera.set', 'camera.frame'],
  measure: ['measurements.read', 'measurements.distance', 'measurements.polyline', 'measurements.angle', 'measurements.radius', 'measurements.reference', 'measurements.clearReference'],
  section: ['section.read', 'section.replace', 'section.add', 'section.remove', 'section.nativeState', 'section.box', 'section.facePlane', 'section.customDistance', 'section.managePlane', 'section.capStyle', 'section.display', 'section.history'],
  annotate: ['annotations.read', 'annotations.create', 'annotations.createAnchored', 'annotations.manage'],
};
export function viewerOperationCoverage() {
  const operations = viewerOperations();
  const inventory = operationControlInventory();
  const ids = (prefixes: readonly string[]) => operations.filter(operation => prefixes.some(prefix => operation.id.startsWith(prefix))).map(operation => operation.id);
  const audit = ['Final non-panel control inventory audit is pending.'];
  const toolIds = [...new Set(['select', 'cesium-placement', 'command', ...Object.keys(TOOL_FEATURE), ...Object.keys(toolFeatureRows(''))])];
  return {
    version: 1, complete: false, panel_count: WORKSPACE_PANELS.length, operation_count: operations.length,
    panels: WORKSPACE_PANELS.map(({ id }) => ({
      id, complete: false, implemented: operations.filter(operation => operation.owner === id).map(operation => operation.id),
      controls: inventory.filter(row => row.owner === id).flatMap(row => row.controls),
      gaps: [...inventory.filter(row => row.owner === id).flatMap(row => row.gaps),
        'Final control inventory audit is pending; no whole-panel completion claim.'],
    })),
    tools: toolIds.map(id => ({ id, complete: false, implemented: TOOL_IMPLEMENTATIONS[id] ?? [],
      gaps: id === 'select' ? ['Surface/ray picking and walk navigation.']
        : id === 'section' ? ['Native pointer-hover preview has numerical face-plane and box equivalents; final tool audit is pending.']
        : id === 'measure' ? ['Pointer-hover/edge-lock feedback is presentation state; numerical modes/readouts are exposed. Final tool audit is pending.']
        : ['Final interactive-tool inventory audit is pending; inspect native authoring.describe for supported proposal kinds.'],
    })),
    non_panel: [
      { id: 'preferences', complete: false, implemented: ids(['preferences.']), gaps: audit },
      { id: 'palette', complete: false, implemented: ['viewer_commands', 'viewer_command_run'], gaps: audit },
      { id: 'file-export', complete: false, implemented: ['viewer_artifacts', 'viewer_artifact_read', 'viewer_artifact_download', 'viewer_artifact_delete', ...ids(['exports.'])], gaps: ['Other main Export dialog formats/options are not yet bound to operations.'] },
      { id: 'contextual-entity', complete: false, implemented: ids(['selection.', 'visibility.', 'basket.', 'authoring.', 'properties.']), gaps: audit },
      { id: 'tours-mobile', complete: false, implemented: ids(['presentation.']), gaps: audit },
      { id: 'runtime-extensions', complete: false, implemented: ids(['extensions.']), gaps: audit },
    ],
    human_only: [
      { id: 'browser-file-picker', reason: 'The browser requires a real user gesture for privileged local file selection.', action: 'Choose the file through the existing viewer picker.' },
      { id: 'provider-credentials', reason: 'Credentials and OAuth consent belong to the existing provider host.', action: 'Connect the provider using its native credential prompt.' },
      { id: 'publication-approval', reason: 'Existing native review authorizes a concrete publication candidate.', action: 'Approve that candidate in the existing publication review.' },
    ],
    limitations: ['No panel is claimed complete.', 'Active-tool store type is string; the finite tool list comes from the feature/authoring inventory plus baseline tools.',
      'Sensitive effects retain native transaction, provider and exact-candidate review boundaries.'],
  };
}
