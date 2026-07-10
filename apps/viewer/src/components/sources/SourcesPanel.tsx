/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, useCallback, useMemo } from 'react';
import type { ConnectionTestResult, SourceFile as PluginSourceFile } from '@ifc-lite/plugin-api';
import { useViewerStore } from '@/store';
import { useSourceHost } from '@/services/sources/SourceHostProvider';
import { SourceSettingsDialog } from './SourceSettingsDialog';
import { SourceBrowser } from './SourceBrowser';
import { Button } from '@/components/ui/button';
import { Cloud, Settings } from 'lucide-react';

interface SourcesPanelProps {
  onClose: () => void;
}

const PREFS_KEY_PREFIX = 'ifc-lite-source-prefs:';

function loadSavedPrefs(providerId: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(PREFS_KEY_PREFIX + providerId);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function savePrefs(providerId: string, values: Record<string, string>): void {
  localStorage.setItem(PREFS_KEY_PREFIX + providerId, JSON.stringify(values));
}

export function SourcesPanel({ onClose }: SourcesPanelProps) {
  const sourceHost = useSourceHost();
  const providers = useMemo(() => sourceHost.list(), [sourceHost]);
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const setSourceTag = useViewerStore((s) => s.setSourceTag);

  const activeProvider = browsing ? sourceHost.get(browsing) : undefined;
  const settingsProvider = settingsFor ? sourceHost.get(settingsFor) : undefined;

  const handleSavePrefs = useCallback(
    (values: Record<string, string>) => {
      if (settingsFor) savePrefs(settingsFor, values);
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
    async (files: PluginSourceFile[]) => {
      if (!activeProvider || !browsing) return;
      const prefs = loadSavedPrefs(browsing);
      const ctx = sourceHost.createContext(activeProvider.manifest, prefs);

      for (const f of files) {
        const buffer = await activeProvider.download(ctx, f.id);
        const tag = sourceHost.createSourceTag(
          browsing,
          '', // projectId tracked in browser state
          f.containerId,
          f.id,
          f.currentRevisionId,
        );
        // Store a pending download event for the load hook to pick up.
        // The actual load goes through the canonical useIfcLoader.loadFile path.
        window.dispatchEvent(
          new CustomEvent('ifc-lite:source-download', {
            detail: { name: f.name, buffer, tag },
          }),
        );
      }
    },
    [activeProvider, browsing, sourceHost],
  );

  if (activeProvider && browsing) {
    const prefs = loadSavedPrefs(browsing);
    const ctx = sourceHost.createContext(activeProvider.manifest, prefs);

    return (
      <SourceBrowser
        provider={activeProvider}
        ctx={ctx}
        onDownload={(files) => void handleDownload(files)}
        onBack={() => setBrowsing(null)}
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
            const prefs = loadSavedPrefs(p.manifest.name);
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
          initialValues={loadSavedPrefs(settingsFor!)}
        />
      )}
    </div>
  );
}
