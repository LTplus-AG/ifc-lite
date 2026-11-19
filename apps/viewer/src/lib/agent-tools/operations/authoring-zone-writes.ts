/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { mutationPermissionForModels } from '@/store/mutation-permission';
import { operation, type OperationContext } from './contract';
import { assertToolActive } from '../cancellation';
import type { ToolHost } from '../types';
import type { VolumeBasis } from '@/lib/zones/volume-basis';
import { evictOldest } from './host-handles';
const outputSchema = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
const out = (value: unknown) => ({ native_json: JSON.stringify(value) });
const meta = (id: string, description: string, effect: 'read' | 'model' | 'artifact' = 'read') => ({ id, owner: 'zones', description, effects: [effect],
  capability: effect === 'read' ? 'read' as const : 'commands-and-edits' as const, implementation: 'native-store' as const, outputSchema,
  policy: effect === 'model' ? { model: 'native-reviewed' as const } : effect === 'artifact' ? { artifact: 'native-export' as const } : undefined });
interface Candidate { setId: string; basis: VolumeBasis; modelIds: string[]; action: 'write' | 'remove'; models: ReturnType<typeof useViewerStore.getState>['models']; revision: number; geometry: unknown; configuration: string;
  /** The assignments the preview table showed; a refresh after prepare would write other elements. */
  assignments: ReturnType<typeof useViewerStore.getState>['zoneAssignments']; result?: unknown }
const hosts = new WeakMap<ToolHost, Map<string, Candidate>>();
function owned(c: OperationContext) { let value = hosts.get(c.host); if (!value) { value = new Map(); hosts.set(c.host, value); } return value; }
function zoneSet(id: string) { const set = useViewerStore.getState().zoneSets.find(row => row.id === id); if (!set) throw new Error('Unknown zone set.'); return set; }
function validate(candidate: Candidate) {
  const state = useViewerStore.getState();
  // geometryResult: a geometry-only update changes the proved volumes without touching models or mutationVersion.
  // (Not geometryUpdateTick, which a recolour also bumps.)
  if (state.models !== candidate.models || state.mutationVersion !== candidate.revision || state.geometryResult !== candidate.geometry || JSON.stringify(zoneSet(candidate.setId)) !== candidate.configuration) throw new Error('Zone/model inputs changed after review.');
  if (state.zoneAssignments !== candidate.assignments) throw new Error('Zone assignments changed after review. Prepare again.');
  const permission = mutationPermissionForModels(state, candidate.modelIds); if (!permission.allowed) throw new Error(`Native write refused: ${permission.reason}`);
}
export const zoneWriteOperations = [
  operation<{ set_id: string; model_ids: string[]; basis: VolumeBasis; action: 'write' | 'remove' }>(meta('zones.writeback.prepare', 'Prepare native zone property/quantity writeback or removal with explicit complete target model population. The preview is the same native facts table as export. Native writeback reports per-model partial outcomes and uses explicit Remove as its inverse; it does not enter native Undo history.'), {
    type: 'object', properties: { set_id: { type: 'string', minLength: 1, maxLength: 200 }, model_ids: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, minItems: 1, maxItems: 100, uniqueItems: true },
      basis: { type: 'string', enum: ['mesh', 'net', 'gross', 'unqualified'] }, action: { type: 'string', enum: ['write', 'remove'] } }, required: ['set_id', 'model_ids', 'basis', 'action'], additionalProperties: false,
  }, async (i, c) => {
    const { buildZoneTable } = await import('@/hooks/useZoneTableExport'); assertToolActive(c); const state = useViewerStore.getState();
    const current = [...state.models].filter(([, model]) => model.ifcDataStore).map(([id]) => id).sort();
    if (JSON.stringify([...i.model_ids].sort()) !== JSON.stringify(current) || !i.model_ids.includes(c.model.id)) throw new Error('model_ids must explicitly name every currently loaded IFC target.');
    const set = zoneSet(i.set_id), rows = buildZoneTable(set, i.basis);
    const candidate: Candidate = { setId: i.set_id, basis: i.basis, modelIds: [...i.model_ids], action: i.action, models: state.models, revision: state.mutationVersion, geometry: state.geometryResult, configuration: JSON.stringify(set), assignments: state.zoneAssignments };
    validate(candidate); evictOldest(owned(c), 32); const token = crypto.randomUUID(); owned(c).set(token, candidate);
    return out({ token, action: i.action, model_ids: i.model_ids, rows, undo: 'explicit-native-remove; not history Undo', partial_outcomes: true });
  }),
  operation<{ token: string }>(meta('zones.writeback.apply', 'Apply the exact reviewed whole-set native writeback/removal. Preserves native per-model eligibility, role checks, volume proofs and explicit partial outcome diagnostics.', 'model'), {
    type: 'object', properties: { token: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['token'], additionalProperties: false,
  }, async (i, c) => {
    const candidate = owned(c).get(i.token); if (!candidate) throw new Error('Unknown zone candidate for this host.'); if (candidate.result) return out(candidate.result);
    const { applyZoneWriteBack, removeZoneWriteBack } = await import('@/hooks/useZoneWriteBack'); validate(candidate); assertToolActive(c);
    // A refusal throws inside commit, so it is never reported as a committed write.
    candidate.result = c.commit(() => {
      validate(candidate); const set = zoneSet(candidate.setId);
      const result = candidate.action === 'write' ? applyZoneWriteBack(set, candidate.basis) : removeZoneWriteBack(set);
      if (result.blocked) throw new Error(`Native zone writeback refused: ${result.blocked}`);
      return result;
    });
    return out(candidate.result);
  }),
  operation<{ set_id: string; zone_id: string }>(meta('zones.geometry.export', 'Build a native GLB geometric section using the same proved-solid exact split service as the panel. Cancellation suppresses artifact publication; an already dispatched native worker may finish.', 'artifact'), {
    type: 'object', properties: { set_id: { type: 'string', minLength: 1, maxLength: 200 }, zone_id: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['set_id', 'zone_id'], additionalProperties: false,
  }, async (i, c) => {
    const { exportZoneGeometry } = await import('@/hooks/useZoneGeometrySplit'); assertToolActive(c);
    const set = zoneSet(i.set_id), index = set.zones.findIndex(zone => zone.id === i.zone_id); if (index < 0) throw new Error('Unknown native zone.');
    const state = useViewerStore.getState(), signature = JSON.stringify(set), models = state.models, tick = state.geometryUpdateTick, revision = state.mutationVersion;
    let captured: { bytes: Uint8Array; filename: string } | undefined;
    const result = await exportZoneGeometry(set, index, { emit: (bytes, filename) => { captured = { bytes, filename }; } });
    assertToolActive(c); const now = useViewerStore.getState();
    if (now.models !== models || now.geometryUpdateTick !== tick || now.mutationVersion !== revision || JSON.stringify(zoneSet(i.set_id)) !== signature) throw new Error('Geometry or zones changed during native export. Discarded result.');
    if (!result.ok || !captured) return out({ result, artifact: null });
    const artifact = await c.artifacts.create({ filename: captured.filename, mimeType: 'model/gltf-binary', data: captured.bytes }); return out({ result, artifact });
  }),
];
