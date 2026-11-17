/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Extension-contributed exporters (#1907) as runtime entries of the export
 * registry (#5838). The `exportMenu` slot is read here once, and the ribbon
 * and command palette render what this returns
 * through `useExportCommands`, so an installed exporter is reachable from
 * every surface a built-in format is — it used to be reachable only from a
 * block inside the IFC dialog.
 *
 * Exporter ids are not namespaced, so two enabled extensions can declare the
 * same one: every entry is keyed by owner AND exporter id, and a run always
 * names its owner (the confused-deputy fix of #1930).
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { PaletteAvailability } from '@/components/viewer/palette-availability';
import type { ExporterContribution } from '@ifc-lite/extensions';
import { toast } from '@/components/ui/toast';
import { useSlotContributions } from '@/hooks/useSlotContributions';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';
import { activeModelName, downloadFile, modelExportFilename, normalizeExtension } from '@/lib/export/download';
import { useTranslation } from '@/i18n';
import { trackExportCompleted } from '@/lib/analytics';
import type { ExportSurface } from '@/lib/analytics-export-events';
import { runningExtensionExport, setRunningExtensionExport, subscribeExtensionExport } from './extension-export-busy';
import { recordActivity } from '@/lib/activity/activity-journal';

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
  checkAvailability?: () => PaletteAvailability;
}

export function useExtensionExporters(surface: ExportSurface) {
  const { t } = useTranslation();
  const host = useOptionalExtensionHost();
  const contributions = useSlotContributions<ExporterContribution>('exportMenu');
  const currentHost = useRef(host);
  currentHost.current = host;
  useEffect(() => { currentHost.current = host; return () => { currentHost.current = null; }; }, [host]);
  const runningKey = useSyncExternalStore(
    listener => subscribeExtensionExport(host, listener),
    () => runningExtensionExport(host), () => null,
  );

  const exporters = useMemo<ExtensionExporter[]>(
    () => (host ? contributions : []).map<ExtensionExporter>((c) => {
      const key = `${c.extensionId}:${c.payload.id}`;
      return {
        key,
        extensionId: c.extensionId,
        payload: c.payload,
        name: c.payload.name,
        extension: normalizeExtension(c.payload.extension),
        running: runningKey === key,
        checkAvailability: () => {
          if (!host || currentHost.current !== host) return { status: 'disabled', reasonKey: 'commandPalette.availability.host' };
          if (!host.slotRegistry.getAll('exportMenu').includes(c)) return { status: 'disabled', reasonKey: 'commandPalette.availability.feature' };
          if (runningExtensionExport(host)) return { status: 'disabled', reasonKey: 'commandPalette.extension.busy' };
          return { status: 'available' };
        },
      };
    }),
    [host, contributions, runningKey],
  );

  const runExtensionExporter = useCallback(async (key: string) => {
    const exporter = exporters.find((e) => e.key === key);
    if (runningExtensionExport(host)) { toast.info(t('commandPalette.extension.busy')); return; }
    let started = false;
    try {
      if (!host || !exporter) throw new Error(`Unregistered extension exporter: ${key}`);
      const availability = exporter.checkAvailability?.();
      if (availability?.status === 'disabled') { toast.info(t(availability.reasonKey)); return; }
      const { extensionId, payload } = exporter;
      // Capture the model name at invocation, rather than naming old bytes for
      // a different model selected while the asynchronous exporter is running.
      const filename = modelExportFilename(activeModelName(useViewerStore.getState()), payload.extension);
      started = true;
      setRunningExtensionExport(host, key);
      await recordActivity({ kind: 'export', title: 'activityTray.job.extensionExport',
        subject: `${payload.name} · ${extensionId}` }, async () => {
        const output = await host.runExporter(payload.id, extensionId);
        // Like every one-click export, the file is named for the active model.
        downloadFile(
          output.data,
          filename,
          payload.mimeType || 'application/octet-stream',
        );
      });
      trackExportCompleted({ format: 'extension', surface });
      toast.success(t('exportCommands.extension.exportedToast', { name: payload.name }));
    } catch (err) {
      console.error(`Extension exporter ${key} failed:`, err);
      toast.error(t('exportCommands.extension.failedToast', {
        name: exporter?.name ?? key,
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      if (started && host) setRunningExtensionExport(host, null);
    }
  }, [host, exporters, t, surface]);

  return { exporters, extensionExportRunning: runningKey !== null, runExtensionExporter };
}
