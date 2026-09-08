/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Save and reopen a portable federation setup (issue #3930).
 *
 * Thin glue between the pure logic in `lib/federation/federationSetupFile.ts`
 * and the live viewer store / canonical load path (`useIfcFederation.addModel`,
 * `realignFederation`). See that module's header for what the saved file
 * references versus embeds, and how alignment is replayed rather than baked in.
 */

import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore, type FederatedModel } from '../store/index.js';
import { useIfc } from './useIfc.js';
import { findReferenceGeorefModel } from './ingest/federationAlign.js';
import {
  buildFederationSetupFile,
  serializeFederationSetupFile,
  matchFederationSetupSlots,
  summarizeFederationSetupMatches,
  type FederationSetupFile,
  type FederationSetupSlotMatch,
} from '../lib/federation/federationSetupFile.js';
import { downloadFile, sanitizeFilename } from '../lib/export/download.js';

/** Result of applying a federation setup — always distinguishes full vs. partial vs. failed restore. */
export interface FederationSetupApplyResult {
  outcome: 'restored' | 'partial' | 'failed';
  /** Models actually (re-)loaded, in the order they were loaded. */
  restoredCount: number;
  totalSlots: number;
  /** Slots for which no local file could be found. */
  missingSlots: string[];
  /** Slots matched only by filename, with different size/content than saved. */
  mismatchedSlots: string[];
  /** True when the saved anchor's model was restored and re-alignment ran. */
  anchorRestored: boolean;
  /** True when the setup had a saved anchor but that model could not be restored. */
  anchorMissing: boolean;
}

export function useFederationSetup() {
  const { addModel, realignFederation } = useIfc();
  const { anchorModelIdOverride, setAnchorModelIdOverride } = useViewerStore(
    useShallow((s) => ({
      anchorModelIdOverride: s.anchorModelIdOverride,
      setAnchorModelIdOverride: s.setAnchorModelIdOverride,
    })),
  );

  /** Build and download the current federation as a portable setup file. Read-only — never mutates the store. */
  const exportFederationSetup = useCallback(async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    const state = useViewerStore.getState();
    const models = Array.from(state.models.values()) as FederatedModel[]; // Map insertion order = load order.
    if (models.length === 0) {
      return { ok: false, error: 'No models loaded — nothing to save.' };
    }
    const reference = findReferenceGeorefModel();
    const anchorModelId = reference?.modelId ?? anchorModelIdOverride ?? null;

    const setup = await buildFederationSetupFile(models, anchorModelId);
    const json = serializeFederationSetupFile(setup);
    const stem = models.length === 1
      ? sanitizeFilename(models[0].name, { fallback: 'federation' })
      : `federation-setup-${models.length}-models`;
    downloadFile(json, `${sanitizeFilename(stem, { fallback: 'federation' })}.federation.json`, 'application/json;charset=utf-8;');
    return { ok: true };
  }, [anchorModelIdOverride]);

  /** Match saved slots to freshly-picked local files, without applying anything yet (for the review step). */
  const matchFederationSetup = useCallback(
    (setup: FederationSetupFile, files: readonly File[]): Promise<FederationSetupSlotMatch[]> =>
      matchFederationSetupSlots(setup, files),
    [],
  );

  /**
   * Load every resolvable (matched or name-only) slot through the ONE canonical
   * load path (`addModel` -> `loadFile`), in saved order, then restore the
   * anchor and re-run alignment. Never silently drops a slot: the return value
   * always states exactly how many restored, which were missing, and whether
   * the anchor could be restored.
   */
  const applyFederationSetup = useCallback(
    async (matches: readonly FederationSetupSlotMatch[]): Promise<FederationSetupApplyResult> => {
      const summary = summarizeFederationSetupMatches(matches);
      const loadable = matches.filter((m) => m.file !== null);

      let restoredCount = 0;
      let restoredAnchorModelId: string | null = null;
      const hadAnchorSlot = matches.some((m) => m.slot.anchor);

      // Sequential, in saved order — mirrors loadFilesSequentially (the WASM
      // parser isn't thread-safe) and preserves the saved federation's
      // relative model order even when some slots are missing.
      for (const match of loadable) {
        if (!match.file) continue;
        const modelId = await addModel(match.file, {
          name: match.slot.name,
          visible: match.slot.visible,
          collapsed: match.slot.collapsed,
        });
        if (modelId) {
          restoredCount += 1;
          if (match.slot.anchor) restoredAnchorModelId = modelId;
        }
      }

      let anchorRestored = false;
      if (restoredAnchorModelId) {
        setAnchorModelIdOverride(restoredAnchorModelId);
        await realignFederation();
        anchorRestored = true;
      }

      const outcome: FederationSetupApplyResult['outcome'] =
        restoredCount === 0 ? 'failed' : restoredCount === matches.length ? 'restored' : 'partial';

      return {
        outcome,
        restoredCount,
        totalSlots: matches.length,
        missingSlots: summary.missing.map((m) => m.slot.name),
        mismatchedSlots: summary.mismatched.map((m) => m.slot.name),
        anchorRestored,
        anchorMissing: hadAnchorSlot && !anchorRestored,
      };
    },
    [addModel, realignFederation, setAnchorModelIdOverride],
  );

  return { exportFederationSetup, matchFederationSetup, applyFederationSetup };
}

export default useFederationSetup;
