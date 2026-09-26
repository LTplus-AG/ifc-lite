/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Extension-contributed exporters (#1907) as runtime entries of the export
 * registry (#5838). The `exportMenu` slot is read here once, and the classic
 * menu, the ribbon and the command palette all render what this returns
 * through `useExportCommands`, so an installed exporter is reachable from
 * every surface a built-in format is — it used to be reachable only from a
 * block inside the IFC dialog.
 *
 * Exporter ids are not namespaced, so two enabled extensions can declare the
 * same one: every entry is keyed by owner AND exporter id, and a run always
 * names its owner (the confused-deputy fix of #1930).
 */

import { useCallback, useMemo, useState } from 'react';
import type { ExporterContribution } from '@ifc-lite/extensions';
import { toast } from '@/components/ui/toast';
import { useSlotContributions } from '@/hooks/useSlotContributions';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';
import { activeModelName, downloadFile, modelExportFilename, normalizeExtension } from '@/lib/export/download';
import { useTranslation } from '@/i18n';
import { trackExportCompleted } from '@/lib/analytics';
import type { UiSurface } from '@/lib/analytics-ui-events';

/** One installed exporter, as the export surfaces render it. */
export interface ExtensionExporter {
  /** `<extensionId>:<exporterId>` — unique even when two extensions share an exporter id. */
  key: string;
  extensionId: string;
  payload: ExporterContribution;
  /** The exporter's own name; extension-supplied, so shown as-is (no catalogue key). */
  name: string;
  /** Normalised file extension, e.g. `.csv`. */
  extension: string;
  /** This exporter is the one running. */
  running: boolean;
}

export function useExtensionExporters(surface: UiSurface) {
  const { t } = useTranslation();
  const host = useOptionalExtensionHost();
  const contributions = useSlotContributions<ExporterContribution>('exportMenu');
  const [runningKey, setRunningKey] = useState<string | null>(null);

  const exporters = useMemo<ExtensionExporter[]>(
    () => (host ? contributions : []).map((c) => {
      const key = `${c.extensionId}:${c.payload.id}`;
      return {
        key,
        extensionId: c.extensionId,
        payload: c.payload,
        name: c.payload.name,
        extension: normalizeExtension(c.payload.extension),
        running: runningKey === key,
      };
    }),
    [host, contributions, runningKey],
  );

  const runExtensionExporter = useCallback(async (key: string) => {
    const exporter = exporters.find((e) => e.key === key);
    if (!host || !exporter) throw new Error(`Unregistered extension exporter: ${key}`);
    const { extensionId, payload } = exporter;
    setRunningKey(key);
    try {
      const output = await host.runExporter(payload.id, extensionId);
      // Like every one-click export, the file is named for the active model.
      downloadFile(
        output.data,
        modelExportFilename(activeModelName(useViewerStore.getState()), payload.extension),
        payload.mimeType || 'application/octet-stream',
      );
      trackExportCompleted({ format: 'extension', surface });
      toast.success(t('exportCommands.extension.exportedToast', { name: payload.name }));
    } catch (err) {
      console.error(`Extension exporter ${key} failed:`, err);
      toast.error(t('exportCommands.extension.failedToast', {
        name: payload.name,
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setRunningKey(null);
    }
  }, [host, exporters, t, surface]);

  return { exporters, extensionExportRunning: runningKey !== null, runExtensionExporter };
}
