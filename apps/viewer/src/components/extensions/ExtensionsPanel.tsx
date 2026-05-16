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
import { Beaker, FilePlus, FileText, GitFork, Lightbulb, Puzzle, Shield, Trash2, Upload, Wrench, X } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useInstalledExtensions } from '@/hooks/useInstalledExtensions';
import { CapabilityReview } from './CapabilityReview';
import { AuditLogPanel } from './AuditLogPanel';
import { IdeasPanel } from './IdeasPanel';
import { RepairQueuePanel } from './RepairQueuePanel';
import { PrivacyPanel } from './PrivacyPanel';
import type { ExtensionInstallSummary } from '@/services/extensions/host';
import { ExtensionInstallError } from '@/services/extensions/host';
import { useViewerStore } from '@/store';

interface ExtensionsPanelProps {
  onClose?: () => void;
}

// Fork-prompt size caps. The whole bundle source flows into the chat
// turn; without limits a large bundle could blow the model's input
// budget on its own.
const MAX_FORK_FILES = 6;
const MAX_FORK_FILE_CHARS = 4000;

export function ExtensionsPanel({ onClose }: ExtensionsPanelProps) {
  const host = useExtensionHost();
  const installed = useInstalledExtensions();
  const queueChatPrompt = useViewerStore((s) => s.queueChatPrompt);
  const setChatPanelVisible = useViewerStore((s) => s.setChatPanelVisible);
  const pendingAuthoredBundle = useViewerStore((s) => s.pendingAuthoredBundle);
  const setPendingAuthoredBundle = useViewerStore((s) => s.setPendingAuthoredBundle);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFork = useCallback(
    async (id: string) => {
      try {
        const bundle = host.loader.getBundle(id);
        if (!bundle) {
          toast.error(`Bundle for ${id} not loaded.`);
          return;
        }
        const manifestText = JSON.stringify(bundle.manifest, null, 2);
        const fileList = Array.from(bundle.files.keys()).filter((p) => p !== 'manifest.json');
        const fileSummaries = fileList
          .slice(0, MAX_FORK_FILES)
          .map((path) => {
            const f = bundle.files.get(path);
            if (!f) return '';
            const fullText = f.text ?? new TextDecoder().decode(f.bytes);
            const truncated = fullText.length > MAX_FORK_FILE_CHARS;
            const text = truncated
              ? `${fullText.slice(0, MAX_FORK_FILE_CHARS)}\n\n/* …truncated (${fullText.length - MAX_FORK_FILE_CHARS} chars omitted) */`
              : fullText;
            // Widget JSON gets the widget fence; manifest is handled
            // separately above; everything else is code. We can't
            // reliably tell widget vs. non-widget JSON by extension —
            // pick the safer "code" fence so the parser doesn't try to
            // re-parse arbitrary JSON as a widget.
            const fence = `ifc-extension-${path.endsWith('.json') && path.startsWith('widgets/') ? 'widget' : 'code'}`;
            return [`\`\`\`${fence} path="${path}"`, text, '```'].join('\n');
          })
          .filter(Boolean)
          .join('\n\n');
        const prompt = [
          `Fork the installed extension ${bundle.manifest.id} (v${bundle.manifest.version}).`,
          '',
          'Current manifest:',
          '```ifc-extension-manifest',
          manifestText,
          '```',
          '',
          fileSummaries
            ? `Current bundle files:\n\n${fileSummaries}`
            : '(no other files in bundle)',
          fileList.length > MAX_FORK_FILES
            ? `\n…plus ${fileList.length - MAX_FORK_FILES} more files not shown.`
            : '',
          '',
          'What would you like to change?',
        ].filter(Boolean).join('\n');
        queueChatPrompt(prompt);
        setChatPanelVisible(true);
        toast.success(`Routed ${bundle.manifest.id} to chat for editing.`);
      } catch (err) {
        toast.error(`Fork failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [host, queueChatPrompt, setChatPanelVisible],
  );
  const [pending, setPending] = useState<{
    bytes: Uint8Array;
    summary: ExtensionInstallSummary;
    previousGrants?: readonly string[];
    previousVersion?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [view, setView] = useState<'installed' | 'ideas' | 'audit' | 'repair' | 'privacy'>('installed');
  /** Per-row "tests running" set so repeated Beaker clicks don't queue. */
  const [runningTests, setRunningTests] = useState<Set<string>>(new Set());

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
  }, [pendingAuthoredBundle, host, setPendingAuthoredBundle]);

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
        if (err instanceof ExtensionInstallError) {
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
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Puzzle className="h-4 w-4" />
          <h2 className="text-sm font-semibold">Extensions</h2>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={view === 'ideas' ? 'secondary' : 'ghost'}
            onClick={() => setView((v) => (v === 'ideas' ? 'installed' : 'ideas'))}
            aria-label="Toggle ideas panel"
            aria-pressed={view === 'ideas'}
          >
            <Lightbulb className="mr-1 h-3.5 w-3.5" />
            Ideas
          </Button>
          <Button
            size="sm"
            variant={view === 'repair' ? 'secondary' : 'ghost'}
            onClick={() => setView((v) => (v === 'repair' ? 'installed' : 'repair'))}
            aria-label="Toggle repair queue"
            aria-pressed={view === 'repair'}
          >
            <Wrench className="mr-1 h-3.5 w-3.5" />
            Repair
          </Button>
          <Button
            size="sm"
            variant={view === 'audit' ? 'secondary' : 'ghost'}
            onClick={() => setView((v) => (v === 'audit' ? 'installed' : 'audit'))}
            aria-label="Toggle audit log"
            aria-pressed={view === 'audit'}
          >
            <FileText className="mr-1 h-3.5 w-3.5" />
            Audit
          </Button>
          <Button
            size="sm"
            variant={view === 'privacy' ? 'secondary' : 'ghost'}
            onClick={() => setView((v) => (v === 'privacy' ? 'installed' : 'privacy'))}
            aria-label="Toggle privacy panel"
            aria-pressed={view === 'privacy'}
          >
            <Shield className="mr-1 h-3.5 w-3.5" />
            Privacy
          </Button>
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

      {/* Description */}
      <div className="border-b px-4 py-2 text-xs text-muted-foreground">
        Bundles run in a sandboxed QuickJS runtime with explicit capability grants.
      </div>

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
        className={`flex-1 overflow-auto transition-colors ${
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
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <FilePlus className="h-8 w-8 text-muted-foreground" />
            <div className="text-sm font-medium">No extensions installed</div>
            <div className="text-xs text-muted-foreground max-w-xs">
              Drop a <code className="font-mono">.iflx</code> bundle here, or
              click <span className="font-medium">Import</span> above.
            </div>
            <div className="mt-3 text-[11px] text-muted-foreground">
              Build a starter bundle with{' '}
              <code className="font-mono">ifc-lite ext init my-tool</code>.
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
                      onClick={() => void handleFork(record.id)}
                      aria-label={`Fork ${record.id}`}
                      title="Fork: edit this extension in the chat"
                    >
                      <GitFork className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={runningTests.has(record.id)}
                      onClick={() => {
                        if (runningTests.has(record.id)) return;
                        setRunningTests((prev) => {
                          const next = new Set(prev);
                          next.add(record.id);
                          return next;
                        });
                        toast.info(`Running tests for ${record.id}…`);
                        host.runTests(record.id)
                          .then((summary) => {
                            if (summary.results.length === 0) {
                              toast.info(`${record.id}: no tests declared.`);
                            } else if (summary.failed === 0) {
                              toast.success(`${record.id}: ${summary.passed}/${summary.results.length} passed`);
                            } else {
                              toast.error(
                                `${record.id}: ${summary.failed} failed — ${summary.results.find((r) => !r.passed)?.error ?? 'see console'}`,
                              );
                              console.warn('[ext-host] test failures:', summary);
                            }
                          })
                          .catch((err) => {
                            toast.error(
                              `Tests failed to run: ${err instanceof Error ? err.message : String(err)}`,
                            );
                          })
                          .finally(() => {
                            setRunningTests((prev) => {
                              const next = new Set(prev);
                              next.delete(record.id);
                              return next;
                            });
                          });
                      }}
                      aria-label={`Run tests for ${record.id}`}
                    >
                      <Beaker className={`h-3.5 w-3.5 ${runningTests.has(record.id) ? 'animate-pulse' : ''}`} />
                    </Button>
                    <Switch
                      checked={record.enabled}
                      onCheckedChange={(checked) => {
                        host.setEnabled(record.id, checked).catch((err) => {
                          toast.error(
                            `Failed to ${checked ? 'enable' : 'disable'} ${record.id}: ${err instanceof Error ? err.message : String(err)}`,
                          );
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
                          toast.error(
                            `Failed to uninstall ${record.id}: ${err instanceof Error ? err.message : String(err)}`,
                          );
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
