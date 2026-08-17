/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ribbon's icon per export format. Exhaustive over `ExportCommandId`, so
 * adding a format to `toolbar/export-commands.ts` fails to compile until the
 * ribbon has an icon for it — the ribbon can never silently skip a format.
 *
 * Isolated in its own module because `@/icons` resolves through the
 * `unplugin-icons` Vite plugin: keeping the import out of `RibbonExportGroup`
 * lets the node test runner render that component.
 */

import { FileCsv, FileGlb, FileHbjson, FileIfc, FileJson, FileKmz, FilePdf, FileUsd, Screenshot } from '@/icons';
import type { ExportIconSet } from '../../toolbar/export-commands';

export const RIBBON_EXPORT_ICONS: ExportIconSet = {
  ifc: FileIfc,
  glb: FileGlb,
  kmz: FileKmz,
  usd: FileUsd,
  energy: FileHbjson,
  csv: FileCsv,
  json: FileJson,
  screenshot: Screenshot,
  pdf: FilePdf,
};
