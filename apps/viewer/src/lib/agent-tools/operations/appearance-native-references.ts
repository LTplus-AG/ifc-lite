/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { viewerOperation, emptySchema, type ViewerOperationContext } from './contract';
import { assertToolActive } from '../cancellation';
import { decodeAppearanceSettings } from './appearance-native-common';
import {
  prepareNativeAppearanceReference,
  placeNativeAppearanceReference,
  type NativeAppearanceReference,
} from '@/lib/appearance/appearance-native-reference';
import { ownReference, type RegisteredAppearanceReference } from '@/lib/appearance/references/types';
import type { AppearanceAssetOwner } from '@/lib/appearance/assets';
import type { ToolHost } from '../types';
import { appearanceAssets } from '@/lib/appearance/model-assets';
import { restoreReferenceSource, referenceEditSettings } from '@/lib/appearance/references/edit';
import { placementFrameKey } from '@/lib/model-placement/persistence';
const outputSchema = {
  type: 'object',
  properties: { native_json: { type: 'string' } },
  required: ['native_json'],
  additionalProperties: false,
};
const out = (value: unknown) => ({ native_json: JSON.stringify(value ?? null) });
const meta = (id: string, description: string, write = false) => ({
  id,
  owner: 'appearance',
  description,
  effects: write ? (['configuration', 'view'] as const) : (['read'] as const),
  capability: write ? ('commands-and-edits' as const) : ('read' as const),
  implementation: 'native-store' as const,
  outputSchema,
});
interface Candidate {
  prepared: NativeAppearanceReference;
  editing: RegisteredAppearanceReference | null;
  owner: AppearanceAssetOwner;
  renderer: NonNullable<ReturnType<typeof getGlobalRenderer>>;
  draftId: string;
  placed?: string;
  placing?: boolean;
  discard?: 'pending' | 'failed';
}
const hosts = new WeakMap<ToolHost, Map<string, Candidate>>();
async function release(value: Candidate) {
  value.renderer.getReferenceImages().remove(value.draftId);
  appearanceAssets.releaseOwner(value.owner);
}
function candidates(c: ViewerOperationContext) {
  let map = hosts.get(c.host);
  if (!map) {
    map = new Map();
    hosts.set(c.host, map);
    const owned = map;
    c.host.lifetimeSignal?.addEventListener(
      'abort',
      () => {
        for (const value of owned.values())
          void release(value).catch((error) => console.warn('[Appearance] Reference preview cleanup failed', error));
        owned.clear();
      },
      { once: true },
    );
  }
  return map;
}
const tokenInput = {
  type: 'object' as const,
  properties: { token: { type: 'string' as const, minLength: 1, maxLength: 100 } },
  required: ['token' as const],
  additionalProperties: false as const,
};
export const appearanceReferenceOperations = [
  viewerOperation(
    meta(
      'appearance.references.read',
      'Inspect native registered reference images, exact reference/history revision and immutable calibration/PDF lineage. This workspace has its own native Undo/Redo.',
    ),
    emptySchema,
    () => {
      const s = useViewerStore.getState();
      return out({
        references: [...s.appearanceReferences.values()],
        revision: s.referenceRevision,
        selected: s.selectedAppearanceReferenceId,
        canUndo: s.referenceUndo.length > 0,
        canRedo: s.referenceRedo.length > 0,
      });
    },
  ),
  viewerOperation<{ reference_id: string }>(
    meta(
      'appearance.references.restoreSource',
      'Restore the exact native source/calibration settings of an existing registered reference for explicit editing. Uses immutable image digest and PDF lineage; never silently substitutes the current PDF raster.',
      true,
    ),
    {
      type: 'object',
      properties: { reference_id: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['reference_id'],
      additionalProperties: false,
    },
    async (i, c) => {
      assertToolActive(c);
      const record = useViewerStore.getState().appearanceReferences.get(i.reference_id);
      if (!record) throw new Error('Unknown native reference.');
      return out(c.commit(() => ({ source: restoreReferenceSource(record), settings: referenceEditSettings(record) })));
    },
  ),
  viewerOperation<{ source_id: string; expected_source: string; settings_json: string; edit_reference_id: string }>(
    meta(
      'appearance.references.prepare',
      'Prepare and render a transient native calibrated reference candidate; does not register/history-commit it. Uses exact native calibration, immutable asset/PDF lineage, workspace frame and edit-identity checks. edit_reference_id empty creates a new reference.',
      true,
    ),
    {
      type: 'object',
      properties: {
        source_id: { type: 'string', minLength: 1, maxLength: 200 },
        expected_source: { type: 'string', maxLength: 1000000 },
        settings_json: { type: 'string', maxLength: 20000 },
        edit_reference_id: { type: 'string', maxLength: 200 },
      },
      required: ['source_id', 'expected_source', 'settings_json', 'edit_reference_id'],
      additionalProperties: false,
    },
    async (i, c) => {
      const settings = await decodeAppearanceSettings(i.settings_json);
      assertToolActive(c);
      if (!c.signal) throw new Error('A live cancellation signal is required.');
      const s = useViewerStore.getState(),
        source = s.appearanceSources.find((item) => item.id === i.source_id),
        editing = i.edit_reference_id ? (s.appearanceReferences.get(i.edit_reference_id) ?? null) : null,
        renderer = getGlobalRenderer();
      if (!source || JSON.stringify(source) !== i.expected_source || !renderer || (i.edit_reference_id && !editing))
        throw new Error('Reference source/edit identity or renderer changed.');
      // Placed candidates hold no preview resources; only live previews count toward the cap.
      for (const [token, row] of candidates(c)) if (row.placed) candidates(c).delete(token);
      if (candidates(c).size >= 32) throw new Error('Reference preview capacity reached.');
      const owner = { kind: 'draft' as const, id: crypto.randomUUID() },
        draftId = `agent-reference:${crypto.randomUUID()}`;
      let adopted = false;
      try {
        const prepared = await prepareNativeAppearanceReference(
          source,
          settings,
          placementFrameKey(s),
          editing,
          owner,
          c.signal,
        );
        assertToolActive(c);
        if (
          getGlobalRenderer() !== renderer ||
          useViewerStore.getState().appearanceSources.find((item) => item.id === source.id) !== source ||
          placementFrameKey(useViewerStore.getState()) !== prepared.record.frameKey
        )
          throw new Error('Native reference inputs changed during preparation.');
        await renderer
          .getReferenceImages()
          .set({ ...prepared.record, id: draftId, corners: prepared.corners, bitmap: prepared.bitmap }, c.signal);
        assertToolActive(c);
        const token = crypto.randomUUID();
        c.commit(() => candidates(c).set(token, { prepared, editing, renderer, owner, draftId }));
        adopted = true;
        return out({ token, reference: prepared.record });
      } finally {
        if (!adopted) {
          renderer.getReferenceImages().remove(draftId);
          appearanceAssets.releaseOwner(owner);
        }
      }
    },
  ),
  viewerOperation<{ token: string }>(
    meta(
      'appearance.references.place',
      'Place/replace the exact prepared native reference as one native reference-history transaction. Rendering precedes a final live-authorized synchronous record commit; source/frame/edit changes or cancellation refuse without a new registered reference.',
      true,
    ),
    tokenInput,
    async (i, c) => {
      const saved = candidates(c).get(i.token);
      if (!saved) throw new Error('Unknown reference candidate for this host.');
      if (saved.discard) throw new Error('The reference candidate is being discarded.');
      if (saved.placed) return out({ reference_id: saved.placed, placed: true });
      assertToolActive(c);
      if (!c.signal || getGlobalRenderer() !== saved.renderer) throw new Error('Native renderer/session changed.');
      if (saved.placing) throw new Error('The reference candidate is being placed.');
      saved.placing = true;
      try {
        const expected = ownReference(saved.prepared.record);
        const current = useViewerStore.getState().appearanceReferences.get(expected.id);
        if (!current || JSON.stringify(current) !== JSON.stringify(expected)) {
          await placeNativeAppearanceReference(saved.prepared, saved.renderer, c.signal, saved.editing, (write) => c.commit(write));
        }
        saved.placed = expected.id;
        await release(saved);
        return out({ reference_id: expected.id, placed: true });
      } finally {
        saved.placing = false;
      }
    },
  ),
  viewerOperation<{ token: string }>(
    meta(
      'appearance.references.discard',
      'Discard only the host-owned transient native reference preview, releasing its renderer/asset leases; leaves registered history intact.',
      true,
    ),
    tokenInput,
    async (i, c) => {
      const saved = candidates(c).get(i.token);
      if (!saved) throw new Error('Unknown reference candidate.');
      if (saved.placing) throw new Error('The reference candidate is being placed.');
      assertToolActive(c);
      if (saved.discard === 'pending') throw new Error('The reference candidate is being discarded.');
      saved.discard = 'pending';
      try { await release(saved); }
      catch (error) { saved.discard = 'failed'; throw error; }
      candidates(c).delete(i.token);
      return out({ discarded: true });
    },
  ),
  viewerOperation<{
    action: 'update' | 'remove' | 'select' | 'undo' | 'redo' | 'import';
    reference_id: string;
    reference_revision: number;
    visible: boolean;
    locked: boolean;
    opacity: number;
    content: string;
  }>(
    meta(
      'appearance.references.action',
      'Update native reference visibility/lock/opacity, select/remove, Undo/Redo or import exact native exported reference definitions. Native workspace frame, locked-record and history/asset ownership rules stay authoritative. Image relink uses the browser file picker.',
      true,
    ),
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['update', 'remove', 'select', 'undo', 'redo', 'import'] },
        reference_id: { type: 'string', maxLength: 200 },
        reference_revision: { type: 'integer', minimum: 0 },
        visible: { type: 'boolean' },
        locked: { type: 'boolean' },
        opacity: { type: 'number', minimum: 0, maximum: 1 },
        content: { type: 'string', maxLength: 10000000 },
      },
      required: ['action', 'reference_id', 'reference_revision', 'visible', 'locked', 'opacity', 'content'],
      additionalProperties: false,
    },
    (i, c) =>
      out(
        c.commit(() => {
          const s = useViewerStore.getState();
          if (s.collabRoomId || s.referenceRevision !== i.reference_revision)
            throw new Error('Native reference workspace changed or is in a shared room.');
          if (
            ['update', 'remove', 'select'].includes(i.action) &&
            i.reference_id &&
            !s.appearanceReferences.has(i.reference_id)
          )
            throw new Error('Unknown reference.');
          if (i.action === 'update')
            s.updateAppearanceReference(i.reference_id, { visible: i.visible, locked: i.locked, opacity: i.opacity });
          else if (i.action === 'remove') s.removeAppearanceReference(i.reference_id);
          else if (i.action === 'select') s.selectAppearanceReference(i.reference_id || null);
          else if (i.action === 'import') s.importAppearanceReferences(i.content);
          else s.replayAppearanceReference(i.action);
          return { revision: useViewerStore.getState().referenceRevision };
        }),
      ),
  ),
  viewerOperation(
    {
      ...meta(
        'appearance.references.export',
        'Export native registered reference definitions/calibration lineage as a host-owned artifact.',
      ),
      effects: ['artifact'],
      capability: 'commands-and-edits',
      policy: { artifact: 'native-export' },
    },
    emptySchema,
    async (_, c) => {
      assertToolActive(c);
      return out(
        await c.artifacts.create({
          filename: 'appearance-references.json',
          mimeType: 'application/json',
          data: useViewerStore.getState().exportAppearanceReferences(),
        }),
      );
    },
  ),
];
