/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF ingest path for the viewer (issue #1782).
 *
 * DXF files are 2D reference drawings, not models: they never enter the
 * model pipeline (`useIfcLoader.loadFile`) — a dropped DXF must not
 * replace or federate with the loaded IFC. Instead the file is parsed
 * with `@ifc-lite/drawing-2d`'s `importDxf` and registered as an underlay
 * consumed by the 2D drawing view. Every file entry point (drop, Open)
 * splits DXFs off first via `splitDxfFiles` and routes the rest onward.
 *
 * Issue #1929: a surveyor's DXF is usually authored in map/CRS coordinates
 * (eastings/northings), not the IFC model's local frame — the mirror image
 * of the `.laz`/`.las` point-cloud alignment issue #1804 already solved.
 * `ingestDxfFile` resolves the anchor model's georeference the same way the
 * DXF export path does and seeds the new underlay's `georeferenced` toggle
 * from whether one is available, so a georeferenced model gets a DXF that
 * lands in the right place by default, while a model with no
 * IfcMapConversion (or none loaded yet) keeps the pre-#1929 behaviour: the
 * DXF's raw coordinates are treated as IFC world coordinates, unmodified.
 */

import { importDxf } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { resolveDxfExportGeoreference } from '@/hooks/dxfExportGeoref';

export function isDxfFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.dxf');
}

/** Partition a picked/dropped file list into DXF underlays and model files. */
export function splitDxfFiles(files: File[]): { dxfFiles: File[]; modelFiles: File[] } {
  const dxfFiles: File[] = [];
  const modelFiles: File[] = [];
  for (const file of files) {
    (isDxfFileName(file.name) ? dxfFiles : modelFiles).push(file);
  }
  return { dxfFiles, modelFiles };
}

/** Parse one DXF file and register it as a reference underlay. */
export async function ingestDxfFile(file: File): Promise<void> {
  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    console.error(`[dxfIngest] reading "${file.name}" failed:`, err);
    toast.error(`Couldn't read "${file.name}".`);
    return;
  }

  let underlay: ReturnType<typeof importDxf>;
  try {
    underlay = importDxf(text, file.name);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[dxfIngest] parsing "${file.name}" failed:`, err);
    toast.error(`DXF import failed for "${file.name}": ${message}`);
    return;
  }

  let count = 0;
  for (const layer of underlay.layers) {
    count += layer.paths.length + layer.fills.length + layer.texts.length;
  }
  if (count === 0) {
    console.warn(`[dxfIngest] "${file.name}" contained no drawable 2D entities`, underlay.skipped, underlay.warnings);
    toast.error(`"${file.name}" contains no drawable 2D entities.`);
    return;
  }
  if (underlay.warnings.length > 0) {
    console.warn(`[dxfIngest] "${file.name}" import warnings:`, underlay.warnings);
  }

  const store = useViewerStore.getState();
  // Default the "DXF is in map/CRS coordinates" toggle ON iff the
  // federation anchor currently has a usable IfcMapConversion (issue
  // #1929) — the same resolution the DXF EXPORT path uses
  // (`resolveDxfExportGeoreference`), so import and export always agree on
  // which model's georeference is authoritative and on user placement
  // edits held in `georefMutations`. No usable map conversion (the common
  // case today, and every session before this issue) leaves the toggle
  // off, so existing DXFs that already line up in IFC world coordinates
  // are never silently moved.
  const georeference = resolveDxfExportGeoreference({
    models: store.models,
    legacyDataStore: store.ifcDataStore,
    georefMutations: store.georefMutations,
  });
  const georeferenced = georeference !== null;
  store.addDxfUnderlay(underlay, { georeferenced });

  const layerCount = underlay.layers.length;
  const assumedMm = underlay.warnings.some((w) => w.includes('assumed millimetres'));
  const unitsNote = assumedMm ? ' (unitless file, assumed mm)' : '';
  const georefNote = georeferenced ? ', aligned to the model georeference' : '';
  if (store.models.size > 0) {
    // Surface the result immediately: the underlay renders in the 2D
    // drawing panel, so open it (the user still picks/moves the section).
    store.setDrawing2DPanelVisible(true);
    toast.success(
      `"${file.name}" imported as reference layer: ${count} elements on ${layerCount} layer${layerCount === 1 ? '' : 's'}${unitsNote}${georefNote}.`,
    );
  } else {
    toast.success(
      `"${file.name}" imported as reference layer${unitsNote}. Load a model and open the 2D section view to see it.`,
    );
  }
}

/** Ingest several DXF files sequentially (order = pick order). */
export async function ingestDxfFiles(files: File[]): Promise<void> {
  for (const file of files) {
    await ingestDxfFile(file);
  }
}
