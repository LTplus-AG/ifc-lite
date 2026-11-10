/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAsyncRun } from '@/hooks/useAsyncRun';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { ExtensionInstallError, type ExtensionHostService, type ExtensionInstallSummary } from '@/services/extensions/host';
import { ExtensionStorageQuotaError } from '@/services/extensions/idb-storage';

class BundleRejectedError extends Error {}
type Review = { bytes: Uint8Array; summary: ExtensionInstallSummary; previousGrants?: readonly string[]; previousVersion?: string };
/** File imports own the active review. Authored bundles wait behind them. */
export function useBundleReview(host: ExtensionHostService) {
  const { t } = useTranslation();
  const authored = useViewerStore(state => state.pendingAuthoredBundle);
  const [pending, updatePending] = useState<Review | null>(null);
  const pendingRef = useRef<Review | null>(null);
  const fileRun = useAsyncRun();
  const authoredRun = useAsyncRun({ key: authored });
  const setPending = useCallback((review: Review | null) => {
    pendingRef.current = review;
    updatePending(review);
  }, []);
  const preview = useCallback(async (bytes: Uint8Array, isCurrent: () => boolean) => {
    const result = await host.previewBundle(bytes);
    if (!isCurrent()) return;
    if (!result.ok) throw new BundleRejectedError(result.errors[0]?.message ?? t('extensionsFlavors.extensionsPanel.unknownError'));
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
      toast.error(t('extensionsFlavors.extensionsPanel.toast.expectedBundle', { filename: file.name }));
      return;
    }
    authoredRun.reset();
    await fileRun.start(async ({ isCurrent }) => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!isCurrent()) return;
        await preview(bytes, isCurrent);
      } catch (error) {
        if (isCurrent()) toast.error(t(error instanceof BundleRejectedError
          ? 'extensionsFlavors.extensionsPanel.toast.bundleUnpackFailed' : 'extensionsFlavors.extensionsPanel.toast.readFileFailed',
        { error: error instanceof Error ? error.message : String(error) }));
      }
    });
  }, [preview, authoredRun.reset, fileRun.start, t]);
  const handleApprove = useCallback(async (grants: string[]) => {
    const review = pendingRef.current;
    if (!review) return;
    await fileRun.start(async ({ isCurrent }) => {
      try {
        const status = await host.installFromBytes(review.bytes, grants);
        if (!isCurrent()) return;
        toast.success(t('extensionsFlavors.extensionsPanel.toast.installed', { id: status.id, version: status.version }));
        if (pendingRef.current === review) setPending(null);
      } catch (error) {
        if (!isCurrent()) return;
        if (error instanceof ExtensionStorageQuotaError) {
          toast.error(t('extensionsFlavors.extensionsPanel.toast.storageFull'));
        } else if (error instanceof ExtensionInstallError) {
          toast.error(t('extensionsFlavors.extensionsPanel.toast.installRejected', {
            error: error.validationErrors[0]?.message ?? error.message,
          }));
        } else {
          toast.error(t('extensionsFlavors.extensionsPanel.toast.installFailed', {
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    });
  }, [host, fileRun.start, setPending, t]);
  useEffect(() => {
    if (!authored || pending || fileRun.busy || authoredRun.busy) return;
    void authoredRun.start(async ({ isCurrent }) => {
      try {
        await preview(authored, isCurrent);
        if (isCurrent()) useViewerStore.getState().setPendingAuthoredBundle(null);
      } catch (error) {
        if (isCurrent()) {
          toast.error(t(error instanceof BundleRejectedError
            ? 'extensionsFlavors.extensionsPanel.toast.authoredBundleUnpackFailed' : 'extensionsFlavors.extensionsPanel.toast.authoredBundlePreviewFailed',
          { error: error instanceof Error ? error.message : String(error) }));
          useViewerStore.getState().setPendingAuthoredBundle(null);
        }
      }
    });
  }, [authored, pending, fileRun.busy, authoredRun.busy, preview, authoredRun.start, t]);
  // Authored previews remain interruptible by a file; file preview/install owns the controls.
  return { pending, setPending, handleFiles, handleApprove, busy: fileRun.busy };
}
