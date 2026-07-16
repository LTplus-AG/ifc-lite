/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, useCallback, useMemo } from 'react';
import type { ConnectionTestResult, SourceFile as PluginSourceFile } from '@ifc-lite/plugin-api';
import { useSourceHost } from '@/services/sources/SourceHostProvider';
import { dispatchSourceDownload } from '@/services/sources/source-host';
import { SourceSettingsDialog } from './SourceSettingsDialog';
import { SourceBrowser } from './SourceBrowser';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { Cloud, Settings } from 'lucide-react';
import { loadSavedSourcePrefs, saveSourcePrefs } from '@/lib/sources/preferences';

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
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const activeProvider = browsing ? sourceHost.get(browsing) : undefined;
  const settingsProvider = settingsFor ? sourceHost.get(settingsFor) : undefined;

  const handleSavePrefs = useCallback(
    (values: Record<string, string>) => {
      if (settingsFor) saveSourcePrefs(settingsFor, values);
    },
    [settingsFor],
  );

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

  const handleDownload = useCallback(
    async ({ projectId, files }: SourceDownloadSelection) => {
      if (!activeProvider || !browsing) return;
      const prefs = loadSavedSourcePrefs(browsing);
      const ctx = sourceHost.createContext(activeProvider.manifest, prefs);
      const providerId = browsing;

      setDownloading(true);
      try {
        const items = [];
        for (const f of files) {
          items.push({
            name: f.name,
            buffer: await activeProvider.download(ctx, f.id),
            sourceFile: f,
            tag: sourceHost.createSourceTag(
              providerId,
              projectId,
              f.containerId,
              f.id,
              f.currentRevisionId,
            ),
          });
        }
        dispatchSourceDownload(items);
        setBrowsing(null);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : 'Failed to download files',
        );
      } finally {
        setDownloading(false);
      }
    },
    [activeProvider, browsing, sourceHost],
  );

  const browsingCtx = useMemo(() => {
    if (!activeProvider || !browsing) return null;
    return sourceHost.createContext(
      activeProvider.manifest,
      loadSavedSourcePrefs(browsing),
    );
  }, [activeProvider, browsing, sourceHost]);

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
      </div>

      <div className="flex-1 overflow-y-auto">
        {providers.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
            <Cloud className="h-8 w-8" />
            <span>No source providers configured</span>
          </div>
        )}

        <ul className="divide-y">
          {providers.map((p) => {
            const prefs = loadSavedSourcePrefs(p.manifest.name);
            const configured = p.manifest.preferences
              .filter((pf) => pf.required)
              .every((pf) => !!prefs[pf.name]?.trim());

            return (
              <li key={p.manifest.name} className="flex items-center gap-2 px-3 py-2">
                <Cloud className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 truncate text-sm">{p.manifest.title}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setSettingsFor(p.manifest.name)}
                >
                  <Settings className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  disabled={!configured}
                  onClick={() => setBrowsing(p.manifest.name)}
                >
                  Browse
                </Button>
              </li>
            );
          })}
        </ul>
      </div>

      {settingsProvider && (
        <SourceSettingsDialog
          manifest={settingsProvider.manifest}
          open={!!settingsFor}
          onOpenChange={(open) => { if (!open) setSettingsFor(null); }}
          onSave={handleSavePrefs}
          onTestConnection={
            settingsProvider.testConnection ? handleTestConnection : undefined
          }
          initialValues={loadSavedSourcePrefs(settingsFor!)}
        />
      )}
    </div>
  );
}
