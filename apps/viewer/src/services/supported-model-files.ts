/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one list of file extensions the viewer can ingest.
 *
 * Every entry point that names extensions derives them from here: the
 * `<input type="file">` accept strings, the drag/drop and picker guards
 * (`isSupportedModelFile`), and the File System Access picker's accept
 * filter in `./file-system-access.ts`. Keeping them derived rather than
 * hand-copied is what stops one path from advertising a format another
 * path silently refuses — `.ifczip` was missing from the picker filter
 * while every other path accepted it, so a zipped IFC appeared greyed out
 * in the Chromium Open dialog.
 */

/** Model formats routed to the model-load pipeline. */
export const MODEL_FILE_EXTENSIONS = [
  '.ifc',
  '.ifcx',
  '.ifczip',
  '.glb',
  '.las',
  '.laz',
  '.ply',
  '.pcd',
  '.e57',
  '.pts',
  '.xyz',
] as const;

/**
 * Reference underlays. `.dxf` is offered by every picker but splits off to
 * the 2D ingest path before model routing, so it is deliberately not part
 * of `MODEL_FILE_EXTENSIONS` / `isSupportedModelFile`.
 */
export const REFERENCE_FILE_EXTENSIONS = ['.dxf'] as const;

/** Everything a file picker should offer the user. */
export const PICKER_FILE_EXTENSIONS: readonly string[] = [
  ...MODEL_FILE_EXTENSIONS,
  ...REFERENCE_FILE_EXTENSIONS,
];

/** `accept` attribute for the hidden `<input type="file">` elements. */
export const FILE_ACCEPT = PICKER_FILE_EXTENSIONS.join(',');

/** Extensions the viewer can ingest (IFC / IFCX / GLB / point clouds). */
export function isSupportedModelFile(f: File): boolean {
  const n = f.name.toLowerCase();
  return MODEL_FILE_EXTENSIONS.some((ext) => n.endsWith(ext));
}
