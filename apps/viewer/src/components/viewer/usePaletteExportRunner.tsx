/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The command palette's export dispatch (#5601). The palette's Export rows
 * are built from `toolbar/export-commands.ts` (`commandPaletteExports.ts`),
 * and this hook runs them through the SAME handlers and dialogs the classic
 * toolbar and the ribbon use — `useExportCommands` for the one-click and CSV
 * exports, the registry's own `Dialog` component for everything with
 * options — so the palette has no export implementation of its own.
 *
 * Dialog formats own their open state behind a `trigger` element (see
 * `ExportDialogComponent`), exactly as `ClassicExportRow` and
 * `RibbonExportGroup` mount them. The palette closes as soon as a row runs,
 * so it cannot host that trigger itself: `CommandPalette` renders `dialog`
 * (outside its own `Dialog`, so it outlives the palette closing) and the
 * trigger is a hidden button that clicks itself once on mount — the same
 * `DialogTrigger` path a toolbar click takes, with no second way in.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/i18n';
import { toast } from '@/components/ui/toast';
import type { CsvExportType, ExportCommandId, ExportDialogComponent } from './toolbar/export-commands';
import { useExportCommands } from './toolbar/useExportCommands';

/**
 * One palette export row's request: CSV names its table, an extension exporter
 * its `<extensionId>:<exporterId>` key, every other format is just its id.
 */
export type PaletteExportRequest =
  | { id: 'csv'; table: CsvExportType }
  | { id: 'extension'; key: string }
  | { id: Exclude<ExportCommandId, 'csv'> };

/**
 * A `DialogTrigger asChild` target that opens its dialog on mount. Radix
 * merges its `onClick`/`ref`/aria props onto this button, so the click below
 * is the dialog's ordinary trigger path. That click TOGGLES the dialog, so it
 * must fire once: Strict Mode replays mount effects in development, and a
 * second click would close the dialog it just opened.
 */
function AutoOpenTrigger({ ref, ...props }: React.ComponentProps<'button'>) {
  const own = useRef<HTMLButtonElement | null>(null);
  const clicked = useRef(false);
  useEffect(() => {
    if (clicked.current || !own.current) return;
    clicked.current = true;
    own.current.click();
  }, []);
  return (
    <button
      {...props}
      type="button"
      hidden
      tabIndex={-1}
      ref={(node) => {
        own.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
    />
  );
}

export function usePaletteExportRunner() {
  const { t } = useTranslation();
  const {
    ifcDataStore, commands, handleExportCSV, runExportAction, extensionExporters, extensionExportRunning, runExtensionExporter,
  } = useExportCommands('palette');
  // `nonce` remounts the dialog so a repeat request opens it again.
  const [requested, setRequested] = useState<{ Dialog: ExportDialogComponent; nonce: number } | null>(null);

  const runExport = useCallback((request: PaletteExportRequest) => {
    if (request.id === 'extension') {
      if (extensionExportRunning) toast.info(t('commandPalette.export.unavailable'));
      else void runExtensionExporter(request.key);
      return;
    }
    const resolved = commands.find(({ command }) => command.id === request.id);
    if (!resolved) throw new Error(`Unregistered export command: ${request.id}`);
    // The toolbars disable these rows; the palette cannot, so it says why instead.
    // CSV also needs source bytes: `handleExportCSV` returns silently without them.
    const noCsvSource = request.id === 'csv' && !(ifcDataStore && ifcDataStore.source.byteLength > 0);
    if (resolved.disabled || noCsvSource) {
      toast.info(t('commandPalette.export.unavailable'));
      return;
    }
    const { command } = resolved;
    if (command.kind === 'dialog') {
      const { Dialog } = command;
      setRequested((prev) => ({ Dialog, nonce: (prev?.nonce ?? 0) + 1 }));
    } else if (command.kind === 'table-menu') {
      if (request.id === 'csv') void handleExportCSV(request.table);
    } else {
      runExportAction(command.action);
    }
  }, [ifcDataStore, commands, handleExportCSV, runExportAction, extensionExportRunning, runExtensionExporter, t]);

  const dialog = requested
    ? <requested.Dialog key={requested.nonce} surface="palette" trigger={<AutoOpenTrigger />} />
    : null;

  return { runExport, dialog, extensionExporters };
}
