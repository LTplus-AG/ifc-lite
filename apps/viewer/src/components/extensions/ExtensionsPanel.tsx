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
import { Beaker, FilePlus, FileText, GitFork, Lightbulb, Puzzle, Shield, Sparkles, Trash2, Upload, Wrench, X } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useInstalledExtensions } from '@/hooks/useInstalledExtensions';
import { useForkExtension } from '@/hooks/useForkExtension';
import { useRunExtensionTests } from '@/hooks/useRunExtensionTests';
import { CapabilityReview } from './CapabilityReview';
import { AuditLogPanel } from './AuditLogPanel';
import { IdeasPanel } from './IdeasPanel';
import { RepairQueuePanel } from './RepairQueuePanel';
import { PrivacyPanel } from './PrivacyPanel';
import type { ExtensionInstallSummary } from '@/services/extensions/host';
import { ExtensionInstallError } from '@/services/extensions/host';
import { ExtensionStorageQuotaError } from '@/services/extensions/idb-storage';
import { useViewerStore } from '@/store';
import * as toastText from './toast-helpers';
import { HelpHint } from './HelpHint';

interface ExtensionsPanelProps {
  onClose?: () => void;
}

export function ExtensionsPanel({ onClose }: ExtensionsPanelProps) {
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
  const [activeFlavorName, setActiveFlavorName] = useState<string | undefined>();
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const flavor = await host.flavors.getActive();
        if (!cancelled) setActiveFlavorName(flavor?.name);
      } catch {
        // Best-effort: header chip just goes blank if read fails.
      }
    };
    void refresh();
    const off = host.flavors.onChange(() => void refresh());
    return () => { cancelled = true; off(); };
  }, [host]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{
    bytes: Uint8Array;
    summary: ExtensionInstallSummary;
    previousGrants?: readonly string[];
    previousVersion?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [view, setView] = useState<'installed' | 'ideas' | 'audit' | 'repair' | 'privacy'>('installed');
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
        toast.error(`Expected a .iflx extension bundle, got ${file.name}.`);
        return;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const preview = await host.previewBundle(bytes);
        if (!preview.ok) {
          toast.error(`Bundle did not unpack: ${preview.errors[0]?.message ?? 'unknown error'}`);
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
        toast.error(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [host],
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
          toast.error(`Authored bundle didn't unpack: ${preview.errors[0]?.message ?? 'unknown'}`);
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
        toast.error(`Authored bundle preview failed: ${err instanceof Error ? err.message : String(err)}`);
        setPendingAuthoredBundle(null);
      }
    })();
  }, [pendingAuthoredBundle, pending, host, setPendingAuthoredBundle]);

  const handleApprove = useCallback(
    async (grants: string[]) => {
      // Two guards: pending may have been cleared by a parallel cancel,
      // and busy stops a double-click from kicking off two installs of
      // the same bytes.
      if (!pending || busy) return;
      setBusy(true);
      try {
        const status = await host.installFromBytes(pending.bytes, grants);
        toast.success(`${status.id} v${status.version} installed`);
        setPending(null);
      } catch (err) {
        if (err instanceof ExtensionStorageQuotaError) {
          toast.error(
            `Out of browser storage. Uninstall an extension or clear some flavors, then retry.`,
          );
        } else if (err instanceof ExtensionInstallError) {
          toast.error(`Install rejected: ${err.validationErrors[0]?.message ?? err.message}`);
        } else {
          toast.error(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        setBusy(false);
      }
    },
    [host, pending, busy],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Title row — always fits regardless of panel width. The tab
          strip moves to its own row below so it can scroll
          horizontally without crowding the title. */}
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <Puzzle className="h-4 w-4 shrink-0" />
          <h2 className="text-sm font-semibold shrink-0">Extensions</h2>
          {activeFlavorName && (
            <button
              type="button"
              onClick={() => setFlavorDialogRequested(true)}
              className="shrink-0 text-[10px] uppercase tracking-wide bg-primary/10 text-primary hover:bg-primary/20 rounded px-1.5 py-0.5 font-semibold transition-colors max-w-[110px] truncate"
              title={`Active flavor: ${activeFlavorName}. Click to manage.`}
              aria-label={`Active flavor: ${activeFlavorName}. Click to open the flavor dialog.`}
            >
              {activeFlavorName}
            </button>
          )}
          <HelpHint
            label="Extensions"
            docLink={{
              href: 'https://github.com/LTplus-AG/ifc-lite/blob/main/docs/guide/extensions.md',
              label: 'Read the Extensions guide →',
            }}
          >
            <p>
              <strong>Extensions</strong> are sandboxed bundles of
              JavaScript that add buttons, panels, lenses, or exporters
              to the viewer.
            </p>
            <p>
              The tab strip below jumps to: <strong>Ideas</strong>{' '}
              (mined patterns + starter suggestions),{' '}
              <strong>Repair</strong> (SDK-update compatibility check),
              <strong> Audit</strong> (lifecycle ledger),{' '}
              <strong>Privacy</strong> (action-log controls + prompt
              overlay).
            </p>
            <p>
              Get started by describing one in chat, browsing starter
              ideas, or importing a <code>.iflx</code> bundle.
            </p>
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
            Import
          </Button>
          {onClose && (
            <Button
              size="icon"
              variant="ghost"
              onClick={onClose}
              aria-label="Close extensions panel"
            >
              <X className="h-4 w-4" />
            </Button>
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
      <div
        className="flex items-center gap-0 border-b overflow-x-auto px-1"
        role="tablist"
        aria-label="Extension surfaces"
      >
        {(
          [
            { id: 'installed', label: 'Installed', Icon: Puzzle },
            { id: 'ideas', label: 'Ideas', Icon: Lightbulb },
            { id: 'repair', label: 'Repair', Icon: Wrench },
            { id: 'audit', label: 'Audit', Icon: FileText },
            { id: 'privacy', label: 'Privacy', Icon: Shield },
          ] as const
        ).map(({ id, label, Icon }) => {
          const active = view === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setView(id)}
              className={`shrink-0 flex items-center gap-1 px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                active
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          );
        })}
      </div>

      {/* Body — every sub-view fills the remaining height and owns its
          own scroll. `min-h-0` lets flex children actually shrink so
          inner ScrollArea / overflow-auto kicks in at narrow heights. */}
      <div className="flex-1 min-h-0 flex flex-col">
      {view === 'audit' ? (
        <AuditLogPanel />
      ) : view === 'ideas' ? (
        <IdeasPanel />
      ) : view === 'repair' ? (
        <RepairQueuePanel />
      ) : view === 'privacy' ? (
        <PrivacyPanel />
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
              <div className="text-sm font-medium">No extensions installed</div>
              <div className="text-xs text-muted-foreground max-w-xs">
                Extensions are sandboxed bundles that add commands,
                lenses, panels, or exporters. You can install one three
                ways:
              </div>
            </div>

            <div className="flex flex-col gap-2 w-full max-w-sm mt-2">
              {/* 1. Author via chat — most discoverable for new users. */}
              <Button
                variant="default"
                size="sm"
                onClick={() => {
                  queueChatPrompt('Author an extension for me. Help me describe it: what should it do?');
                  setChatPanelVisible(true);
                  setScriptPanelVisible(true);
                }}
              >
                <Sparkles className="mr-2 h-3.5 w-3.5" />
                Describe one in chat (AI authors it)
              </Button>

              {/* 2. Browse curated starter ideas. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setView('ideas')}
              >
                <Lightbulb className="mr-2 h-3.5 w-3.5" />
                Browse starter ideas
              </Button>

              {/* 3. Drop / import an .iflx file from elsewhere. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="mr-2 h-3.5 w-3.5" />
                Import a .iflx file
              </Button>
            </div>

            <div className="mt-2 text-[10px] text-muted-foreground text-center">
              All extensions run in a sandbox with explicit capability
              grants. Build one from the CLI with{' '}
              <code className="font-mono">ifc-lite ext init</code>.
            </div>
          </div>
        ) : (
          <ul className="divide-y">
            {installed.map((record) => (
              <li key={record.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs break-all">{record.id}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      v{record.version} · {record.grantedCapabilities.length}{' '}
                      {record.grantedCapabilities.length === 1 ? 'capability' : 'capabilities'}{' '}
                      · {new Date(record.installedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => handleFork(record.id)}
                      aria-label={`Fork ${record.id}`}
                      title="Fork: edit this extension in the chat"
                    >
                      <GitFork className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={isRunning(record.id)}
                      onClick={() => runTests(record.id)}
                      aria-label={`Run tests for ${record.id}`}
                    >
                      <Beaker className={`h-3.5 w-3.5 ${isRunning(record.id) ? 'animate-pulse' : ''}`} />
                    </Button>
                    <Switch
                      checked={record.enabled}
                      onCheckedChange={(checked) => {
                        host.setEnabled(record.id, checked).catch((err) => {
                          toast.error(toastText.failed(checked ? 'Enable' : 'Disable', err));
                        });
                      }}
                      aria-label={record.enabled ? 'Disable extension' : 'Enable extension'}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        if (!confirm(`Uninstall ${record.id}?`)) return;
                        host.uninstall(record.id).catch((err) => {
                          toast.error(toastText.failed('Uninstall', err));
                        });
                      }}
                      aria-label={`Uninstall ${record.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {record.grantedCapabilities.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {record.grantedCapabilities.slice(0, 4).map((cap) => (
                      <code
                        key={cap}
                        className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono"
                      >
                        {cap}
                      </code>
                    ))}
                    {record.grantedCapabilities.length > 4 && (
                      <span className="text-[10px] text-muted-foreground self-center">
                        +{record.grantedCapabilities.length - 4} more
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
      </div>

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
    </div>
  );
}
