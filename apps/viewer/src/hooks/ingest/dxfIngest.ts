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
 *
 * PR #1965 review: `ingestDxfFile` used to resolve the anchor's
 * georeference SYNCHRONOUSLY at import time and bake the result into the
 * new underlay's `georeferenced` toggle as a plain boolean. That races the
 * REPORTER'S ACTUAL WORKFLOW: `ViewportContainer.handleDrop` splits DXFs
 * off first (`splitDxfFiles`) and fires `void ingestDxfFiles(dxfFiles)`
 * immediately, concurrently with — not after — the model files' load. Drop
 * `model.ifc` and `survey.dxf` together and this function used to run
 * before `ifcDataStore`/`models` had the new model in them, resolve no
 * georeference, and seed the toggle OFF — the DXF lands kilometres away and
 * the toast says nothing wrong. That made the documented "DXF dropped
 * before any IFC model loads" case the DEFAULT outcome for a combined
 * drop, not a rare edge.
 *
 * Fix: `ingestDxfFile` now seeds the toggle to `'auto'` (stored as
 * `undefined` — see `DxfUnderlayState.georeferenced`'s doc in
 * `drawing2DSlice.ts`), which `dxfUnderlayMath.ts`'s
 * `resolveEffectiveGeoreferenced` resolves LAZILY every render from
 * whatever the anchor's georeference currently is. A same-drop model that
 * finishes loading after the DXF still ends up aligned, with no race,
 * and an anchor removed/re-added later in the session is followed too.
 * Explicit `true`/`false` are written ONLY when the user flips the
 * checkbox (`setDxfUnderlayGeoreferenced`) — auto-seeded entries and
 * user-set entries are stored identically once explicit, but only THIS
 * function's import path ever creates an entry in auto mode; every other
 * `addDxfUnderlay` call site defaults to `false` (see that action's doc),
 * so an entry that predates this feature (or any future load/migration
 * path that doesn't explicitly request `'auto'`) can never silently start
 * following the anchor.
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
  const layerCount = underlay.layers.length;
  const assumedMm = underlay.warnings.some((w) => w.includes('assumed millimetres'));

  // Seed the "DXF is in map/CRS coordinates" toggle (issue #1929, tri-state
  // per the PR #1965 review — see the module doc above for the race this
  // closes). Normally 'auto': resolved lazily at render time from whatever
  // the anchor's georeference is THEN, not baked in now.
  //
  // Exception: a unitless DXF whose extents forced the "assumed
  // millimetres" heuristic (`@ifc-lite/drawing-2d`'s `importDxf`,
  // dividing every coordinate by 1000) cannot also be safely
  // auto-georeferenced. The inverse IfcMapConversion subtracts FULL
  // eastings/northings (metres, ~1e5-1e7 magnitude); applied to
  // coordinates that were just divided by 1000 on top of an unverified
  // unit guess, the two assumptions compound into a placement millions of
  // metres off (e.g. an LV95 model: raw survey coordinates already close
  // to the model's eastings, misread as mm, land the underlay around
  // -2,597,400 m instead of near the model). Seed `false` (explicit "off",
  // not auto) so a later-loaded georeferenced model can't silently apply
  // that compounded error, and tell the user why in the toast below.
  const georeferenced: boolean | 'auto' = assumedMm ? false : 'auto';
  store.addDxfUnderlay(underlay, { georeferenced });

  // For the import toast's wording ONLY — this does not seed the toggle
  // (that's always 'auto' above, resolved lazily) — snapshot whether an
  // anchor georeference happens to be available right now, including
  // `anchorModelIdOverride` so this agrees with the pinned-anchor rule
  // `useDxfUnderlay.ts` and `useDrawingExport.ts` both apply (previously
  // omitted here; this function's own claim that import and export "always
  // agree on which model is authoritative" was not true until this
  // matched).
  const georeference = assumedMm
    ? null
    : resolveDxfExportGeoreference({
      models: store.models,
      legacyDataStore: store.ifcDataStore,
      anchorModelIdOverride: store.anchorModelIdOverride,
      georefMutations: store.georefMutations,
    });
  const unitsNote = assumedMm
    ? ' (unitless file, assumed mm — georeference alignment left off to avoid compounding the unit guess with a map-coordinate subtraction; enable it manually once you\'ve confirmed the units)'
    : '';
  const georefNote = georeference ? ', aligned to the model georeference' : '';
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
