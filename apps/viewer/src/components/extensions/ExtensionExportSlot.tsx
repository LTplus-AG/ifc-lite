/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ExtensionExportSlot` — render extension exporter contributions.
 *
 * Consumes the `exportMenu` slot. Until this existed the slot had no reader:
 * `loader.ts` registered every declared `exporters` contribution and nothing
 * ever displayed it, so the documented authoring path produced an extension
 * that installed correctly and then did nothing (#1907).
 *
 * Lives outside `ExportDialog.tsx` deliberately — that file is already well
 * past the ~400-line house rule, and this is a self-contained concern.
 */

import { useState } from 'react';
import { Download, Loader2, Puzzle } from 'lucide-react';
import type { ExporterContribution } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { useSlotContributions } from '@/hooks/useSlotContributions';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { downloadFile } from '@/lib/export/download';
import { buildExportFilename, normalizeExtension } from '@/lib/export/extension-filename';

interface ExtensionExportSlotProps {
  /** Base name for the produced file, before the exporter's extension. */
  baseName: string;
}

export function ExtensionExportSlot({ baseName }: ExtensionExportSlotProps) {
  const host = useOptionalExtensionHost();
  const contributions = useSlotContributions<ExporterContribution>('exportMenu');
  const [runningId, setRunningId] = useState<string | null>(null);

  if (!host || contributions.length === 0) return null;

  const handleRun = async (extensionId: string, payload: ExporterContribution) => {
    setRunningId(payload.id);
    try {
      const output = await host.runExporter(payload.id, extensionId);
      // `downloadFile` is the only sanctioned save path: it copies wasm-backed
      // buffers into a BlobPart and emits the tour event a hand-rolled
      // <a download> would skip.
      downloadFile(
        output.data,
        buildExportFilename(baseName, payload.extension),
        payload.mimeType || 'application/octet-stream',
      );
      toast.success(`Exported with ${payload.name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`"${payload.name}" failed: ${message}`);
    } finally {
      setRunningId(null);
    }
  };

  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-2">
        <Puzzle className="h-4 w-4" />
        From extensions
      </Label>
      <div className="flex flex-col gap-2">
        {contributions.map((c) => {
          const payload = c.payload;
          const busy = runningId === payload.id;
          return (
            <Button
              key={`${c.extensionId}:${payload.id}`}
              variant="outline"
              className="justify-start"
              disabled={runningId !== null}
              onClick={() => { void handleRun(c.extensionId, payload); }}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Download className="h-4 w-4 mr-2" />
              )}
              {payload.name}
              <span className="ml-auto text-xs text-muted-foreground">
                {normalizeExtension(payload.extension)}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
