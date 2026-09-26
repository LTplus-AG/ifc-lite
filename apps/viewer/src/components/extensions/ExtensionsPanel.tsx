/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ExtensionsPanel` — dock panel surface for managing installed user
 * extensions.
 *
 * Listing: each installed extension shows its id, version, granted
 * capabilities (collapsed to count), enable/disable switch, and
 * uninstall button.
 *
 * Import: drag a `.iflx` file onto the dropzone (or click "Import") to
 * launch the capability review dialog. After approval, the host
 * installs the bundle and the list refreshes.
 *
 * Phase 1 scope. The audit log view and promote-to-tool flow are
 * separate components landing later.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Beaker, FilePlus, FileText, GitFork, Lightbulb, Puzzle, Sparkles, Trash2, Upload, Wrench, X } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useInstalledExtensions } from '@/hooks/useInstalledExtensions';
import { useForkExtension } from '@/hooks/useForkExtension';
import { useRunExtensionTests } from '@/hooks/useRunExtensionTests';
import { CapabilityReview } from './CapabilityReview';
import { AuditLogPanel } from './AuditLogPanel';
import { IdeasPanel } from './IdeasPanel';
import { RepairQueuePanel } from './RepairQueuePanel';
import type { ExtensionInstallSummary } from '@/services/extensions/host';
import { ExtensionInstallError } from '@/services/extensions/host';
import { ExtensionStorageQuotaError } from '@/services/extensions/idb-storage';
import { useViewerStore } from '@/store';
import { HelpHint } from './HelpHint';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { formatExtensionDate } from './localized-date';
import { localizedFlavorName } from './localized-flavor-metadata';
import { useActiveFlavor } from './use-active-flavor';
interface ExtensionsPanelProps {
  onClose?: () => void;
}

export function ExtensionsPanel({ onClose }: ExtensionsPanelProps) {
  const { t, locale } = useTranslation();
  const host = useExtensionHost();
  const installed = useInstalledExtensions();
  const handleFork = useForkExtension();
  const { runTests, isRunning } = useRunExtensionTests();
  const pendingAuthoredBundle = useViewerStore((s) => s.pendingAuthoredBundle);
  const setPendingAuthoredBundle = useViewerStore((s) => s.setPendingAuthoredBundle);
  /** Empty-state "describe in chat" CTA + Sparkles button. */
  const queueChatPrompt = useViewerStore((s) => s.queueChatPrompt);
  const setChatPanelVisible = useViewerStore((s) => s.setChatPanelVisible);
  const setScriptPanelVisible = useViewerStore((s) => s.setScriptPanelVisible);
  /** Active-flavor name surfaced in the panel header to give the concept impressions. */
  const setFlavorDialogRequested = useViewerStore((s) => s.setFlavorDialogRequested);
  const activeFlavor = useActiveFlavor(host);
  const activeFlavorName = activeFlavor ? localizedFlavorName(activeFlavor, t) : undefined;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{
    bytes: Uint8Array;
    summary: ExtensionInstallSummary;
    previousGrants?: readonly string[];
    previousVersion?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [view, setView] = useState<'installed' | 'ideas' | 'audit' | 'repair'>('installed');
  /** Deep-link entry point (Command Palette "Author an extension…"). */
  const extensionsRequestedView = useViewerStore((s) => s.extensionsRequestedView);
  const setExtensionsRequestedView = useViewerStore((s) => s.setExtensionsRequestedView);

  useEffect(() => {
    if (extensionsRequestedView) {
      setView(extensionsRequestedView);
      setExtensionsRequestedView(null);
    }
  }, [extensionsRequestedView, setExtensionsRequestedView]);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const file = files[0];
      if (!file.name.toLowerCase().endsWith('.iflx')) {
        toast.error(t('extensionsFlavors.extensionsPanel.toast.expectedBundle', { filename: file.name }));
        return;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const preview = await host.previewBundle(bytes);
        if (!preview.ok) {
          toast.error(t('extensionsFlavors.extensionsPanel.toast.bundleUnpackFailed', { error: preview.errors[0]?.message ?? t('extensionsFlavors.extensionsPanel.unknownError') }));
          return;
        }
        // Detect upgrade: same id already installed → pass the previous
        // grants into the review screen so it can surface a diff.
        const records = await host.listInstalled();
        const existing = records.find((r) => r.id === preview.value.id);
        setPending({
          bytes,
          summary: preview.value,
          previousGrants: existing?.grantedCapabilities,
          previousVersion: existing ? `v${existing.version}` : undefined,
        });
      } catch (err) {
        toast.error(t('extensionsFlavors.extensionsPanel.toast.readFileFailed', { error: err instanceof Error ? err.message : String(err) }));
      }
    },
    [host, t],
  );

  // Authoring loop hand-off: when the chat panel produces a clean
  // bundle, it stashes the bytes in `pendingAuthoredBundle` and opens
  // the Extensions panel. Pick them up on mount, route through the
  // standard preview → Capability Review flow.
  useEffect(() => {
    if (!pendingAuthoredBundle) return;
    // Don't clobber a capability review already on screen (e.g. from a
    // file import). Leave the authored bundle queued — the effect
    // re-runs once `pending` clears.
    if (pending) return;
    const bytes = pendingAuthoredBundle;
    void (async () => {
      try {
        const preview = await host.previewBundle(bytes);
        if (!preview.ok) {
          toast.error(t('extensionsFlavors.extensionsPanel.toast.authoredBundleUnpackFailed', { error: preview.errors[0]?.message ?? t('extensionsFlavors.extensionsPanel.unknownError') }));
          setPendingAuthoredBundle(null);
          return;
        }
        const records = await host.listInstalled();
        const existing = records.find((r) => r.id === preview.value.id);
        setPending({
          bytes,
          summary: preview.value,
          previousGrants: existing?.grantedCapabilities,
          previousVersion: existing ? `v${existing.version}` : undefined,
        });
        setPendingAuthoredBundle(null);
      } catch (err) {
        toast.error(t('extensionsFlavors.extensionsPanel.toast.authoredBundlePreviewFailed', { error: err instanceof Error ? err.message : String(err) }));
        setPendingAuthoredBundle(null);
      }
    })();
  }, [pendingAuthoredBundle, pending, host, setPendingAuthoredBundle, t]);

  const handleApprove = useCallback(
    async (grants: string[]) => {
      // Two guards: pending may have been cleared by a parallel cancel,
      // and busy stops a double-click from kicking off two installs of
      // the same bytes.
      if (!pending || busy) return;
      setBusy(true);
      try {
        const status = await host.installFromBytes(pending.bytes, grants);
        toast.success(t('extensionsFlavors.extensionsPanel.toast.installed', { id: status.id, version: status.version }));
        setPending(null);
      } catch (err) {
        if (err instanceof ExtensionStorageQuotaError) {
          toast.error(t('extensionsFlavors.extensionsPanel.toast.storageFull'));
        } else if (err instanceof ExtensionInstallError) {
          toast.error(t('extensionsFlavors.extensionsPanel.toast.installRejected', {
            error: err.validationErrors[0]?.message ?? err.message,
          }));
        } else {
          toast.error(t('extensionsFlavors.extensionsPanel.toast.installFailed', {
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      } finally {
        setBusy(false);
      }
    },
    [host, pending, busy, t],
  );

  return (
    <Tabs value={view} onValueChange={(value) => setView(value as typeof view)} className="flex flex-col h-full">
      {/* Title row — always fits regardless of panel width. The tab
          strip moves to its own row below so it can scroll
          horizontally without crowding the title. */}
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <Puzzle className="h-4 w-4 shrink-0" />
          <h2 className="text-sm font-semibold shrink-0">{t('extensionsFlavors.extensionsPanel.heading')}</h2>
          {activeFlavorName && (
            <button
              type="button"
              onClick={() => setFlavorDialogRequested(true)}
              className="shrink-0 text-2xs uppercase tracking-wide bg-primary/10 text-primary hover:bg-primary/20 rounded px-1.5 py-0.5 font-semibold transition-colors max-w-[110px] truncate"
              title={t('extensionsFlavors.extensionsPanel.activeFlavorTitle', { name: activeFlavorName })}
              aria-label={t('extensionsFlavors.extensionsPanel.activeFlavorAriaLabel', { name: activeFlavorName })}
            >
              {activeFlavorName}
            </button>
          )}
          <HelpHint
            label={t('extensionsFlavors.extensionsPanel.heading')}
            docLink={{
              href: 'https://github.com/LTplus-AG/ifc-lite/blob/main/docs/guide/extensions.md',
              label: t('extensionsFlavors.extensionsPanel.helpHint.docLinkLabel'),
            }}
          >
            <p>{t('extensionsFlavors.extensionsPanel.helpHint.intro')}</p>
            <p>{t('extensionsFlavors.extensionsPanel.helpHint.tabStripInfo')}</p>
            <p>{t('extensionsFlavors.extensionsPanel.helpHint.gettingStarted')}</p>
          </HelpHint>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
          >
            <Upload className="mr-1 h-3.5 w-3.5" />
            {t('extensionsFlavors.extensionsPanel.importButton')}
          </Button>
          {onClose && (
            <IconButton
              label={t('extensionsFlavors.extensionsPanel.closeAriaLabel')}
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </IconButton>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".iflx"
          className="hidden"
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {/* Tab strip — its own row so the title row never crowds it.
          Horizontally scrollable when the panel narrows. */}
      <TabsList
        className="flex h-auto items-center justify-start gap-0 rounded-none border-b bg-transparent overflow-x-auto px-1 py-0"
        aria-label={t('extensionsFlavors.extensionsPanel.tabStripAriaLabel')}
      >
        {(
          [
            { id: 'installed', label: t('extensionsFlavors.extensionsPanel.tab.installed'), Icon: Puzzle },
            { id: 'ideas', label: t('extensionsFlavors.extensionsPanel.tab.ideas'), Icon: Lightbulb },
            { id: 'repair', label: t('extensionsFlavors.extensionsPanel.tab.repair'), Icon: Wrench },
            { id: 'audit', label: t('extensionsFlavors.extensionsPanel.tab.audit'), Icon: FileText },
          ] as const
        ).map(({ id, label, Icon }) => {
          return (
            <TabsTrigger
              key={id}
              value={id}
              className="shrink-0 flex items-center gap-1 rounded-none px-3 py-1.5 text-xs font-medium border-b-2 border-transparent bg-transparent shadow-none transition-colors data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </TabsTrigger>
          );
        })}
      </TabsList>

      {/* Body — every sub-view fills the remaining height and owns its
          own scroll. `min-h-0` lets flex children actually shrink so
          inner ScrollArea / overflow-auto kicks in at narrow heights. */}
      <TabsContent value={view} className="mt-0 flex-1 min-h-0 flex flex-col">
      {view === 'audit' ? (
        <AuditLogPanel />
      ) : view === 'ideas' ? (
        <IdeasPanel />
      ) : view === 'repair' ? (
        <RepairQueuePanel />
      ) : (
      <div
        className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden transition-colors ${
          dragOver ? 'bg-primary/5' : ''
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void handleFiles(e.dataTransfer.files);
        }}
      >
        {installed.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-8">
            <div className="flex flex-col items-center gap-2 text-center">
              <FilePlus className="h-8 w-8 text-muted-foreground" />
              <div className="text-sm font-medium">{t('extensionsFlavors.extensionsPanel.emptyState.title')}</div>
              <div className="text-xs text-muted-foreground max-w-xs">
                {t('extensionsFlavors.extensionsPanel.emptyState.description')}
              </div>
            </div>

            <div className="flex flex-col gap-2 w-full max-w-sm mt-2">
              {/* 1. Author via chat — most discoverable for new users. */}
              <Button
                variant="default"
                size="sm"
                onClick={() => {
                  queueChatPrompt(t('extensionsFlavors.extensionsPanel.emptyState.authoringPrompt'));
                  setChatPanelVisible(true);
                  setScriptPanelVisible(true);
                }}
              >
                <Sparkles className="mr-2 h-3.5 w-3.5" />
                {t('extensionsFlavors.extensionsPanel.emptyState.describeInChat')}
              </Button>

              {/* 2. Browse curated starter ideas. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setView('ideas')}
              >
                <Lightbulb className="mr-2 h-3.5 w-3.5" />
                {t('extensionsFlavors.extensionsPanel.emptyState.browseIdeas')}
              </Button>

              {/* 3. Drop / import an .iflx file from elsewhere. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="mr-2 h-3.5 w-3.5" />
                {t('extensionsFlavors.extensionsPanel.emptyState.importFile')}
              </Button>
            </div>

            <div className="mt-2 text-2xs text-muted-foreground text-center">
              {t('extensionsFlavors.extensionsPanel.emptyState.cliHint')}
            </div>
          </div>
        ) : (
          <ul className="divide-y">
            {installed.map((record) => (
              <li key={record.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs break-all">{record.id}</div>
                    <div className="mt-0.5 text-2xs text-muted-foreground">
                      {t('extensionsFlavors.extensionsPanel.row.stats', {
                        version: record.version,
                        count: record.grantedCapabilities.length,
                        countDisplay: formatLocaleNumber(locale, record.grantedCapabilities.length),
                        date: formatExtensionDate(record.installedAt, locale, true),
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <IconButton
                      label={t('extensionsFlavors.extensionsPanel.row.forkAriaLabel', { id: record.id })}
                      tooltip={t('extensionsFlavors.extensionsPanel.row.forkTitle')}
                      onClick={() => handleFork(record.id)}
                    >
                      <GitFork className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton
                      label={t('extensionsFlavors.extensionsPanel.row.runTestsAriaLabel', { id: record.id })}
                      disabled={isRunning(record.id)}
                      onClick={() => runTests(record.id)}
                    >
                      <Beaker className={`h-3.5 w-3.5 ${isRunning(record.id) ? 'animate-pulse' : ''}`} />
                    </IconButton>
                    <Switch
                      checked={record.enabled}
                      onCheckedChange={(checked) => {
                        host.setEnabled(record.id, checked).catch((err) => {
                          toast.error(t('extensionsFlavors.extensionsPanel.toast.operationFailed', {
                            operation: t(checked
                              ? 'extensionsFlavors.extensionsPanel.operation.enable'
                              : 'extensionsFlavors.extensionsPanel.operation.disable'),
                            error: err instanceof Error ? err.message : String(err),
                          }));
                        });
                      }}
                      aria-label={
                        record.enabled
                          ? t('extensionsFlavors.extensionsPanel.row.disableAriaLabel')
                          : t('extensionsFlavors.extensionsPanel.row.enableAriaLabel')
                      }
                    />
                    <IconButton
                      label={t('extensionsFlavors.extensionsPanel.row.uninstallAriaLabel', { id: record.id })}
                      onClick={async () => {
                        if (!await confirmDialog({ description: t('extensionsFlavors.extensionsPanel.confirmUninstall', { id: record.id }), destructive: true })) return;
                        host.uninstall(record.id).catch((err) => {
                          toast.error(t('extensionsFlavors.extensionsPanel.toast.operationFailed', {
                            operation: t('extensionsFlavors.extensionsPanel.operation.uninstall'),
                            error: err instanceof Error ? err.message : String(err),
                          }));
                        });
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                </div>
                {record.grantedCapabilities.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {record.grantedCapabilities.slice(0, 4).map((cap) => (
                      <code
                        key={cap}
                        className="rounded bg-muted px-1.5 py-0.5 text-2xs font-mono"
                      >
                        {cap}
                      </code>
                    ))}
                    {record.grantedCapabilities.length > 4 && (
                      <span className="text-2xs text-muted-foreground self-center">
                        {t('extensionsFlavors.extensionsPanel.row.moreCapabilities', {
                          count: formatLocaleNumber(locale, record.grantedCapabilities.length - 4),
                        })}
                      </span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      )}
      </TabsContent>
      {pending && (
        <CapabilityReview
          open
          summary={pending.summary}
          previousGrants={pending.previousGrants}
          previousVersion={pending.previousVersion}
          onApprove={handleApprove}
          onCancel={() => setPending(null)}
        />
      )}
    </Tabs>
  );
}
