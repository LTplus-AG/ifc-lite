/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF byte-encoding + download for the section-DXF export (issue #1861),
 * split out of `useDrawingExport.ts` alongside that file's other DXF
 * sibling, `dxfExportGeoref.ts`.
 *
 * `exportToDXF`'s string return is DXF R12 text declaring `$DWGCODEPAGE
 * ANSI_1252` (see `@ifc-lite/drawing-2d`'s `dxf/writer.ts`), not UTF-8 — DXF
 * has no UTF-8 support before R2007 (AC1021). `downloadFile`'s default
 * string encoding (`Blob`) would UTF-8-encode it, mismatching that
 * declared codepage: every real DXF reader (AutoCAD, `ezdxf`, ...) then
 * decodes non-ASCII TEXT content as mojibake ("Wände" round-trips as
 * "WÃ¤nde"). `downloadDxf` encodes to the codepage the file itself
 * declares before handing it to `downloadFile`.
 */

import { downloadFile } from '@/lib/export/download';
import { toast } from '@/components/ui/toast';
import { encodeDxfCp1252 } from '@ifc-lite/drawing-2d';

export function createDxfDownload(dxf: string, filename: string) {
  const { bytes, hadUnmappable } = encodeDxfCp1252(dxf);
  return { filename, blob: new Blob([new Uint8Array(bytes)], { type: 'application/dxf' }), hadUnmappable };
}

/** Encode `dxf` to windows-1252 bytes and download it as `filename`. Toasts once if a character had no windows-1252 representation. */
export function downloadDxf(dxf: string, filename: string): void {
  const { blob, hadUnmappable } = createDxfDownload(dxf, filename);
  if (hadUnmappable) {
    toast.info('Some characters have no DXF R12 text encoding and were exported as "?".');
  }
  downloadFile(blob, filename, 'application/dxf');
}
