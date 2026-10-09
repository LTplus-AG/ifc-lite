/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StoreApi } from 'zustand';
import { StoreEditor } from '@ifc-lite/mutations';
import { effectiveMetadataRecord } from '@ifc-lite/parser';
import type { ViewerState } from '@/store';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { mutationDenial } from '@/store/mutation-permission';
import { emitSpatialZones } from '@/lib/zones/emit-spatial-zones';
import { readOnlyModelEditLease } from './model-authoring-read-target';
import { resolveGlobalId } from './resolve-global-id';
import { readZoneEmissionSnapshot } from './zone-emission-evidence';
import { parseZoneEmissionProposal, type ZoneEmissionProposal } from './zone-emission-proposal';
import type { ModelChangeReceipt } from './model-change-commit';
import { batchDigest } from './model-change-preview';
import { sameReportEvidence } from '@/lib/flow/report-provenance';
export function prepareZoneEmission(store: StoreApi<ViewerState>, input: ZoneEmissionProposal) {
  const proposal = parseZoneEmissionProposal(JSON.stringify(input)), state = store.getState();
  const deny = mutationDenial(state, proposal.modelId); if (deny) throw new Error(deny);
  const lease = readOnlyModelEditLease(state, proposal.modelId); if (!lease) throw new Error('Native model unavailable');
  const ref = resolveGlobalId(state, { globalId: proposal.storey.GlobalId, modelId: proposal.modelId });
  if (!ref) throw new Error('Explicit current storey is unavailable or ambiguous');
  const snapshot = readZoneEmissionSnapshot(state, proposal.modelId, proposal.zoneSetId, ref.expressId);
  if (snapshot.storey.Name !== proposal.storey.Name || !sameReportEvidence(proposal.expected, snapshot)) throw new Error('The complete current native zone-set evidence differs; attach again');
  const dry = lease.target.view.prepareAtomic(view => {
    const draft = new StoreEditor(lease.target.dataStore, view), before = new Set(draft.getNewEntities().map(row => row.expressId));
    const outcome = emitSpatialZones(draft, lease.target.dataStore, snapshot.set, snapshot.members, snapshot.frame, { view, storeyId: ref.expressId, rebased: snapshot.rebased });
    if (outcome.refusal) throw new Error(outcome.refusal);
    const created = draft.getNewEntities().filter(row => !before.has(row.expressId));
    if (created.length > 1000) throw new Error('The native output graph exceeds the review limit');
    return { outcome, created: created.map(row => ({ expressId: row.expressId, type: row.type })) };
  }).result;
  const original = JSON.stringify({ proposal, snapshot, dry }), digest = batchDigest({ proposal, snapshot, dry });
  const sources = [...state.models].map(([id, model]) => ({ id, model, source: model.ifcDataStore?.source, hash: model.sourceContentHash, fingerprint: model.sourceFingerprint }));
  const validate = (initializing = false) => {
    if (original !== JSON.stringify({ proposal, snapshot, dry })) throw new Error('The reviewed proposal or native output changed');
    const current = store.getState();
    if (mutationDenial(current, proposal.modelId)) throw new Error('Native model editing is no longer allowed');
    if (sources.length !== current.models.size || sources.some(row => current.models.get(row.id) !== row.model || row.model.ifcDataStore?.source !== row.source || row.model.sourceContentHash !== row.hash || row.model.sourceFingerprint !== row.fingerprint)) throw new Error('A loaded source owner changed after review');
    if (!initializing) lease.validate();
    if (JSON.stringify(readZoneEmissionSnapshot(current, proposal.modelId, proposal.zoneSetId, ref.expressId, initializing ? proposal.modelId : undefined)) !== JSON.stringify(snapshot)) throw new Error('Native evaluation, zone set, members, frame or prior output changed after review');
  };
  let used = false;
  return { proposal, snapshot, dry, validate: () => validate(), commit(origin: string): ModelChangeReceipt {
    if (used) throw new Error('This reviewed native emission was already applied');
    validate();
    const batchId = crypto.randomUUID();
    const made = recordModellingEdit(store, proposal.modelId, (_methods, draft) => {
      validate(true);
      const before = new Set(draft.getNewEntities().map(row => row.expressId));
      const outcome = emitSpatialZones(draft, lease.target.dataStore, snapshot.set, snapshot.members, snapshot.frame, { view: draft.getMutationView(), storeyId: ref.expressId, rebased: snapshot.rebased });
      if (outcome.refusal) throw new Error(outcome.refusal);
      return draft.getNewEntities().filter(row => !before.has(row.expressId) && row.type === 'IfcSpatialZone');
    }, batchId);
    used = true;
    return { version: 1, kind: 'zones.emit', id: crypto.randomUUID(), title: proposal.title, digest, createdAt: new Date().toISOString(), origin,
      status: 'applied', batches: [{ modelId: proposal.modelId, batchId }], applied: made.map((row, index) => {
        const record = effectiveMetadataRecord(lease.target.dataStore, row.expressId, store.getState().mutationViews.get(proposal.modelId));
        return { index, op: 'zones.emit', modelId: proposal.modelId, globalId: typeof record?.attributes[0] === 'string' ? record.attributes[0] : '', field: 'IfcSpatialZone', before: null, after: JSON.stringify(record) };
      }), skipped: [] };
  } };
}
export type ZoneEmissionReview = ReturnType<typeof prepareZoneEmission>;
