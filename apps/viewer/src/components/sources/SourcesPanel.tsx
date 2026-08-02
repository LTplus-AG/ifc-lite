/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { ConnectionTestResult, SourceFile as PluginSourceFile } from '@ifc-lite/plugin-api';
import { useSourceHost } from '@/services/sources/SourceHostProvider';
import { dispatchSourceDownload } from '@/services/sources/source-host';
import { SourceSettingsDialog } from './SourceSettingsDialog';
import { SourceBrowser } from './SourceBrowser';
import { SourceProviderRow } from './SourceProviderRow';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { AlertCircle, Cloud, X } from 'lucide-react';
import { useViewerStore } from '@/store';
import { loadResolvedSourcePrefs, saveSourcePrefs } from '@/lib/sources/preferences';
import { sanitizeFilename } from '@/lib/export/download';
import { clearAllSourceData } from '@/lib/sources/persistence';
import { claimRevisionWatchSlot, watchSourceRevisions } from '@/lib/sources/revisionWatch';

interface SourcesPanelProps {
  onClose: () => void;
}

interface SourceDownloadSelection {
  readonly projectId: string;
  readonly files: readonly PluginSourceFile[];
}

export function SourcesPanel({ onClose }: SourcesPanelProps) {
  const sourceHost = useSourceHost();
  const providers = useMemo(() => sourceHost.list(), [sourceHost]);
  const registrationFailures = useMemo(
    () => sourceHost.getRegistrationFailures(),
    [sourceHost],
  );
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  // Bumped when saved prefs change so rows/contexts re-derive configured state.
  const [prefsVersion, setPrefsVersion] = useState(0);

  // Cancels in-flight downloads when the panel unmounts (close / navigate away).
  const downloadAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => downloadAbortRef.current?.abort(), []);

  const activeProvider = browsing ? sourceHost.get(browsing) : undefined;
  const settingsProvider = settingsFor ? sourceHost.get(settingsFor) : undefined;

  // Background change detection for loaded source models, one pass per panel
  // mount, gated per provider on `capabilities.changeDetection`.
  useEffect(() => {
    const tags = useViewerStore.getState().sourceTags;
    if (tags.size === 0) return;
    if (!claimRevisionWatchSlot()) return;
    const controller = new AbortController();
    void watchSourceRevisions(sourceHost, tags, controller.signal).then((updates) => {
      if (controller.signal.aborted || updates.length === 0) return;
      const deleted = updates.filter((u) => u.event.deleted).length;
      const changed = updates.length - deleted;
      const parts: string[] = [];
      if (changed > 0) parts.push(`${changed} loaded model${changed === 1 ? ' has' : 's have'} a newer revision`);
      if (deleted > 0) parts.push(`${deleted} source file${deleted === 1 ? ' is' : 's are'} gone upstream`);
      toast.info(`${parts.join('; ')} — use Sync to update.`);
    });
    return () => controller.abort();
  }, [sourceHost]);

  const handleSavePrefs = useCallback(
    (values: Record<string, string>) => {
      if (settingsFor) {
        saveSourcePrefs(settingsFor, values);
        setPrefsVersion((v) => v + 1);
      }
    },
    [settingsFor],
  );

  const handleForgetPrefs = useCallback(() => {
    if (settingsFor) {
      // Sweep everything the feature stored for this provider — prefs (API
      // key), catalog caches, downloaded-file records, watch cursors, and the
      // provider's own storage namespace. On a shared machine "forget" has to
      // mean all of it.
      clearAllSourceData(settingsFor);
      setPrefsVersion((v) => v + 1);
    }
  }, [settingsFor]);

  const handleTestConnection = useCallback(
    async (values: Record<string, string>): Promise<ConnectionTestResult> => {
      if (!settingsProvider) return { ok: false, message: 'No provider' };
      const ctx = sourceHost.createContext(settingsProvider.manifest, values);
      if (settingsProvider.testConnection) {
        return settingsProvider.testConnection(ctx);
      }
      return { ok: false, message: 'Provider does not support connection testing' };
    },
    [settingsProvider, sourceHost],
  );

  // Downloads run one file at a time and each finished file is dispatched
  // (and its buffer reference dropped) before the next download starts, so
  // whole batches of large IFCs are never held in memory simultaneously.
  // The viewport listener serializes the resulting loads.
  const handleDownload = useCallback(
    async ({ projectId, files }: SourceDownloadSelection) => {
      if (!activeProvider || !browsing) return;
      const prefs = loadResolvedSourcePrefs(activeProvider.manifest);
      const ctx = sourceHost.createContext(activeProvider.manifest, prefs);
      const providerId = browsing;
      const providerTitle = activeProvider.manifest.title;

      downloadAbortRef.current?.abort();
      const controller = new AbortController();
      downloadAbortRef.current = controller;

      setDownloading(true);
      try {
        let queued = 0;
        for (const f of files) {
          if (controller.signal.aborted) break;
          try {
            const buffer = await activeProvider.download(
              ctx,
              { projectId, containerId: f.containerId, fileId: f.id },
              { signal: controller.signal },
            );
            dispatchSourceDownload([
              {
                // `f.name` is provider-supplied and reaches `new File(...)` and
                // `addModel`, so it is untrusted input to a filename position.
                // Sanitize at the boundary rather than trusting every provider
                // to have done it — the same contract the export paths use.
                name: sanitizeFilename(f.name, { fallback: 'model.ifc' }),
                buffer,
                sourceFile: f,
                tag: sourceHost.createSourceTag(
                  providerId,
                  projectId,
                  f.containerId,
                  f.id,
                  f.currentRevisionId,
                ),
              },
            ]);
            queued += 1;
          } catch (err) {
            if (controller.signal.aborted) break;
            toast.error(
              err instanceof Error
                ? `${f.name}: ${err.message}`
                : `Failed to download ${f.name} from ${providerTitle}`,
            );
          }
        }
        if (queued > 0) setBrowsing(null);
      } finally {
        setDownloading(false);
      }
    },
    [activeProvider, browsing, sourceHost],
  );

  const browsingCtx = useMemo(() => {
    if (!activeProvider || !browsing) return null;
    // prefsVersion re-derives the context after settings changes.
    void prefsVersion;
    return sourceHost.createContext(
      activeProvider.manifest,
      loadResolvedSourcePrefs(activeProvider.manifest),
    );
  }, [activeProvider, browsing, sourceHost, prefsVersion]);

  // Stable initial values for the settings dialog — a fresh object every
  // render would wipe the form whenever the panel re-renders.
  const settingsInitialValues = useMemo(() => {
    if (!settingsProvider) return undefined;
    void prefsVersion;
    return loadResolvedSourcePrefs(settingsProvider.manifest);
  }, [settingsProvider, prefsVersion]);

  if (activeProvider && browsingCtx) {
    return (
      <SourceBrowser
        provider={activeProvider}
        ctx={browsingCtx}
        onDownload={(selection) => void handleDownload(selection)}
        onBack={() => setBrowsing(null)}
        busy={downloading}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">Cloud Sources</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 rounded-sm"
          aria-label="Close"
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {providers.length === 0 && registrationFailures.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
            <Cloud className="h-8 w-8" aria-hidden />
            <span>No source providers configured</span>
          </div>
        )}

        <ul className="divide-y">
          {providers.map((p) => (
            <SourceProviderRow
              key={p.manifest.name}
              provider={p}
              sourceHost={sourceHost}
              prefsVersion={prefsVersion}
              onOpenSettings={() => setSettingsFor(p.manifest.name)}
              onBrowse={() => setBrowsing(p.manifest.name)}
            />
          ))}
        </ul>

        {registrationFailures.length > 0 && (
          <div className="border-t px-3 py-2">
            <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
              Unavailable providers
            </div>
            <ul className="flex flex-col gap-1.5">
              {registrationFailures.map((failure) => (
                <li
                  key={failure.provider}
                  className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400"
                >
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>
                    <span className="font-medium">{failure.provider}</span> failed to register:{' '}
                    {failure.reason}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {settingsProvider && (
        <SourceSettingsDialog
          manifest={settingsProvider.manifest}
          open={!!settingsFor}
          onOpenChange={(open) => { if (!open) setSettingsFor(null); }}
          onSave={handleSavePrefs}
          onForget={handleForgetPrefs}
          onTestConnection={
            settingsProvider.testConnection ? handleTestConnection : undefined
          }
          initialValues={settingsInitialValues}
        />
      )}
    </div>
  );
}
