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

import { useCallback, useRef, useState } from 'react';
import { FilePlus, Puzzle, Trash2, Upload, X } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useInstalledExtensions } from '@/hooks/useInstalledExtensions';
import { CapabilityReview } from './CapabilityReview';
import type { ExtensionInstallSummary } from '@/services/extensions/host';
import { ExtensionInstallError } from '@/services/extensions/host';

interface ExtensionsPanelProps {
  onClose?: () => void;
}

export function ExtensionsPanel({ onClose }: ExtensionsPanelProps) {
  const host = useExtensionHost();
  const installed = useInstalledExtensions();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{
    bytes: Uint8Array;
    summary: ExtensionInstallSummary;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

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
        setPending({ bytes, summary: preview.value });
      } catch (err) {
        toast.error(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [host],
  );

  const handleApprove = useCallback(
    async (grants: string[]) => {
      if (!pending) return;
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
    [host, pending],
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

      {/* Drop zone + list */}
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
                    <Switch
                      checked={record.enabled}
                      onCheckedChange={(checked) => {
                        void host.setEnabled(record.id, checked);
                      }}
                      aria-label={record.enabled ? 'Disable extension' : 'Enable extension'}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        if (!confirm(`Uninstall ${record.id}?`)) return;
                        void host.uninstall(record.id);
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

      {pending && (
        <CapabilityReview
          open
          summary={pending.summary}
          onApprove={handleApprove}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
