/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { PANEL_SURFACE_COMMANDS } from '@/components/viewer/surface-commands-panels';
import { hasInstancedShards } from '@/store/instancedShardModels';
import type { ViewerState } from '@/store';
import type { AdapterReadiness, EvidenceAdapter, SourceActionAdapter, SourceActionAvailability, SourceActionDescriptors } from './types';

/** Describe the existing native hosts, without inventing another command catalogue (#7160). */
export function describeSourceActions(adapter: EvidenceAdapter): SourceActionDescriptors {
  const panel = adapter.panelIds[0];
  const command = PANEL_SURFACE_COMMANDS.find(item => item.panelId === panel);
  return {
    open: { panel, commandId: command?.id ?? null, requires: ['workspace-panel-host'] },
    discuss: { requires: ['evidence'], unavailableKey: adapter.unavailableKey },
    run: adapter.id === 'clash'
      ? { kind: 'native', producer: 'clash', requires: ['native-clash-host', 'clash-geometry', 'clash-idle'] }
      : { kind: 'panel-controls', reasonKey: 'assistant.pickRunInPanel' },
  };
}

/** Native inputs were delivered, not a guarantee of resident/eligible triangles or a successful run.
 * IFNS handoff is model-owned and survives queue drain; flat totals and optional hash maps miss it.
 * Only model records/array sizes are read. Native gatherElements remains the authoritative preflight. */
function clashInputsAvailable(state: ViewerState): boolean {
  for (const [modelId, model] of state.models) {
    if (model.ifcDataStore && model.geometryResult
      && (model.geometryResult.meshes.length > 0 || hasInstancedShards(modelId))) return true;
  }
  return false;
}

export function sourceActionAvailability(adapter: SourceActionAdapter, state: ViewerState,
  readiness: AdapterReadiness = adapter.readiness(state)): SourceActionAvailability {
  const run = adapter.actions.run;
  const reasonKey = run.kind === 'panel-controls' ? run.reasonKey
    : state.clashRunning ? 'assistant.pickRunning'
    : !clashInputsAvailable(state) ? 'assistant.pickNeedsGeometry' : null;
  return { open: true, discuss: readiness.ready, run: { available: reasonKey === null, reasonKey } };
}
