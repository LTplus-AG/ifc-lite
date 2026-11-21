/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { coordination, textSchema } from './coordination-common';
import { emptySchema } from './contract';
import { internal, invalidInput, stale, unavailable } from './refusals';
async function compared() {
  const [{ comparedModelIdentities }, { acceptedForPair }] = await Promise.all([import('@/lib/compare/identitySidecar'), import('@/lib/compare/acceptedIdentity')]);
  const state = useViewerStore.getState(), result = state.compareResult; if (!result || state.compareRunning || state.compareKeyProperty !== result.keyProperty) throw unavailable('A current completed native comparison/key scheme is required.');
  const identities = await comparedModelIdentities(result, state.models); if ('error' in identities) throw unavailable(identities.error);
  const guard = () => { const live = useViewerStore.getState(); if (live.models !== state.models || live.compareResult !== result || live.compareKeyProperty !== result.keyProperty || live.compareAcceptedIdentity !== state.compareAcceptedIdentity) throw stale('Native comparison source/key/identity decisions changed.'); }; guard();
  const pair = { baseModelId: result.baseModelId, headModelId: result.headModelId, keyProperty: result.keyProperty }; return { state, result, identities, pair, accepted: acceptedForPair(state.compareAcceptedIdentity, pair), guard };
}
export const coordinationPortableOperations = [
  coordination<{ kind: 'identity-map' | 'lineage' }>('compare.exportSidecar', 'Export the native identity-map or lineage sidecar pinned to full source SHA-256 digests and authored key scheme, through the shared native serializer.', ['artifact'], {
    type: 'object', properties: { kind: { type: 'string', enum: ['identity-map', 'lineage'] } }, required: ['kind'], additionalProperties: false,
  }, async (i, c) => { const [{ comparisonSidecarArtifact }, prepared] = await Promise.all([import('@/lib/compare/identitySidecar'), compared()]); prepared.guard(); const artifact = comparisonSidecarArtifact(i.kind, prepared.result, prepared.identities, prepared.accepted); return c.artifacts.create({ filename: artifact.filename, mimeType: 'application/json', data: artifact.data }); }),
  coordination('compare.importSidecar', 'Import reviewed identity-map entries only when native full-source digests, compared pair and authored key scheme match. Native ownership-aware identity admission reports every refused alias; rerun compare to publish the updated diff.', ['configuration'], textSchema, async (i, c) => { const [{ readIdentityMapSidecar }, prepared] = await Promise.all([import('@/lib/compare/identitySidecar'), compared()]); const parsed = readIdentityMapSidecar(i.value, prepared.identities, prepared.result.keyProperty); if ('error' in parsed) throw invalidInput('invalid-value', parsed.error); return c.commit(() => { prepared.guard(); const refused = useViewerStore.getState().acceptCompareIdentity(prepared.pair, parsed.entries); return { refused, accepted: parsed.entries.length - refused.length, requires_rerun: true }; }); }),
  coordination('review.exportWorkspace', 'Export native portable review decisions using the canonical backup codec, preserving unsaved review recovery evidence and statuses.', ['artifact'], emptySchema, async (_, c) => {
    const [{ createContentBackup, encodeContentBackup }, { reviewWorkspaceLibrary, useReviewWorkspaces }] = await Promise.all([import('@/lib/storage/content-backup'), import('@/lib/review/workspace')]); await reviewWorkspaceLibrary.initialize(); const state = useReviewWorkspaces.getState(); const backup = createContentBackup({ validation: [], comparison: [], document: [], reviewWorkspaces: state.entries }, { reviewWorkspaces: state.status }); backup.drafts = backup.drafts?.filter(draft => draft.kind === 'reviewWorkspaces'); return c.artifacts.create({ filename: 'review-workspace.json', mimeType: 'application/json', data: JSON.stringify(encodeContentBackup(backup), null, 2) });
  }),
  coordination('review.importWorkspace', 'Import only review-workspace records from a canonical native backup. Native atomic conflict planning preserves differing originals under fresh identities; no assistant answer becomes a review decision implicitly.', ['configuration'], textSchema, async (i, c) => {
    const [{ parseContentBackup, importContentBackup }, { reviewWorkspaceLibrary, useReviewWorkspaces }] = await Promise.all([import('@/lib/storage/content-backup'), import('@/lib/review/workspace')]); const backup = parseContentBackup(i.value);
    if (Object.entries(backup.libraries).some(([kind, rows]) => kind !== 'reviewWorkspaces' && Array.isArray(rows) && rows.length) || backup.drafts?.some(draft => draft.kind !== 'reviewWorkspaces')) throw invalidInput('invalid-value', 'This endpoint accepts a review-only native backup.');
    const ready = await reviewWorkspaceLibrary.initialize(); if (!ready) throw internal('Native review storage is unavailable.');
    return c.commitAsync(async () => { let receipts: import('@/lib/storage/content-library').ContentCommitReceipt[] = []; const imported = await importContentBackup(backup, () => ({ validation: [], comparison: [], document: [], reviewWorkspaces: useReviewWorkspaces.getState().entries }), true, rows => { receipts = [...rows]; }); await reviewWorkspaceLibrary.refresh(receipts); return { imported, storage: useReviewWorkspaces.getState().status }; });
  }),
];
