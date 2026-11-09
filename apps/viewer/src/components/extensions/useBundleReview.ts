/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import type { ExtensionHostService, ExtensionInstallSummary } from '@/services/extensions/host';

type Review = { bytes: Uint8Array; summary: ExtensionInstallSummary; previousGrants?: readonly string[]; previousVersion?: string };
/** File imports own the active review. Authored bundles wait behind them. */
export function useBundleReview(host: ExtensionHostService) {
  const { t } = useTranslation();
  const authored = useViewerStore(state => state.pendingAuthoredBundle);
  const [pending, updatePending] = useState<Review | null>(null);
  const pendingRef = useRef<Review | null>(null);
  const origin = useRef<'file' | 'authored' | null>(null);
  const { run, release, busy } = useSingleFlight();
  const setPending = useCallback((review: Review | null) => { pendingRef.current = review; updatePending(review); }, []);
  const preview = useCallback(async (bytes: Uint8Array, isCurrent: () => boolean) => {
    const result = await host.previewBundle(bytes);
    if (!isCurrent()) return;
    if (!result.ok) throw new Error(result.errors[0]?.message ?? t('extensionsFlavors.extensionsPanel.unknownError'));
    const installed = await host.listInstalled();
    if (!isCurrent()) return;
    const existing = installed.find(row => row.id === result.value.id);
    setPending({ bytes, summary: result.value, previousGrants: existing?.grantedCapabilities,
      previousVersion: existing ? `v${existing.version}` : undefined });
  }, [host, t, setPending]);
  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length || pendingRef.current) return;
    const file = files[0];
    if (!file.name.toLowerCase().endsWith('.iflx')) {
      toast.error(t('extensionsFlavors.extensionsPanel.toast.expectedBundle', { filename: file.name })); return;
    }
    if (origin.current === 'authored') release();
    await run(async isCurrent => {
      origin.current = 'file';
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!isCurrent()) return;
        await preview(bytes, isCurrent);
      } catch (error) {
        if (isCurrent()) toast.error(t('extensionsFlavors.extensionsPanel.toast.readFileFailed', { error: error instanceof Error ? error.message : String(error) }));
      } finally { if (isCurrent()) origin.current = null; }
    });
  }, [preview, release, run, t]);
  useEffect(() => {
    if (!authored || pending || busy) return;
    void run(async isCurrent => {
      origin.current = 'authored';
      const owns = () => isCurrent() && useViewerStore.getState().pendingAuthoredBundle === authored;
      try {
        await preview(authored, owns);
        if (owns()) useViewerStore.getState().setPendingAuthoredBundle(null);
      } catch (error) {
        if (owns()) {
          toast.error(t('extensionsFlavors.extensionsPanel.toast.authoredBundlePreviewFailed', { error: error instanceof Error ? error.message : String(error) }));
          useViewerStore.getState().setPendingAuthoredBundle(null);
        }
      } finally { if (isCurrent()) origin.current = null; }
    });
  }, [authored, pending, busy, preview, run, t]);
  return { pending, setPending, handleFiles };
}
