/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Rust-backed export formats (ifc-lite-export via wasm): OBJ, glTF/GLB,
 * JSON-LD, IFCX, USD, STEP. Split out of export.ts (#4047) — this is the one
 * cohesive block that shares the wasm GeometryProcessor bootstrap, the
 * isolation-set / filter-matched-zero handling, and the opt-in geometry
 * diagnostics pass.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { GeometryProcessor, isNoRenderGeometryError } from '@ifc-lite/geometry';
import { countGlbMeshes } from '@ifc-lite/export';
import { getFlag, hasFlag, fatal, writeOutput } from '../output.js';
import { logger } from '../logger.js';
import { formatGeometryReport, NO_DIAGNOSTICS_LINE } from '../geometry-report.js';
import type { IfcDataStore } from '@ifc-lite/parser';

/**
 * Resolve the raw IFC bytes (parsed store source, or re-read from disk) plus a
 * one-shot wasm GeometryProcessor for the Rust-backed exporters (OBJ / glTF / JSON-LD).
 *
 * Every Rust exporter below takes the WHOLE file, so the source is genuinely
 * materialised here (#2183). It is handed back rather than scoped through a
 * callback because the caller is one `switch` arm of a single CLI invocation
 * that also runs the optional diagnostics pass over the same bytes; the buffer
 * dies with the command.
 */
async function rustExportContext(
  store: IfcDataStore,
  filePath: string,
): Promise<{ bytes: Uint8Array; gp: GeometryProcessor }> {
  let bytes: Uint8Array;
  if (store.source.byteLength > 0) {
    bytes = store.source.materialize();
  } else {
    const buf = await readFile(filePath);
    bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const gp = new GeometryProcessor();
  await gp.init();
  return { bytes, gp };
}

/**
 * Handle the `obj | gltf | glb | jsonld | ifcx | usd | step` export formats.
 * Whole-model formats (ifcx/usd) never isolate, so filters were skipped by the
 * caller and must not gate the export here — only the isolating formats treat
 * a filter as active.
 */
export async function exportRustFormat(
  format: string,
  args: string[],
  store: IfcDataStore,
  filePath: string,
  refs: Array<{ expressId: number }>,
  filterRequested: boolean,
  wholeModelFormat: boolean,
): Promise<void> {
  const outPath = getFlag(args, '--out');
  const filterActive = !wholeModelFormat && filterRequested;
  const isolated = filterActive
    ? new Uint32Array(refs.map((r) => r.expressId))
    : new Uint32Array();
  // An empty isolation set means "export everything" to the Rust exporters, so a
  // filter that matched nothing would silently dump the whole model. Fail loudly
  // instead — the user asked for a subset and got zero matches.
  if (filterActive && isolated.length === 0) {
    fatal('Filter matched 0 entities — nothing to export. Check --type/--storey/--where/--limit.');
  }
  // --profile: attribute wall-time between the per-invocation wasm
  // bootstrap (GeometryProcessor init) and the export itself - the
  // fixed-overhead split the throughput plan needs for tiny inputs.
  const profileFlag = hasFlag(args, '--profile');
  const tInit = performance.now();
  const { bytes, gp } = await rustExportContext(store, filePath);
  if (profileFlag) {
    process.stderr.write(`profile: wasm init ${(performance.now() - tInit).toFixed(0)}ms\n`);
  }
  const tWork = performance.now();
  try {
    if (format === 'ifcx') {
      const out = gp.exportIfcx(bytes);
      if (out == null) fatal('IFCX export failed (geometry pipeline not initialized)');
      await writeOutput(out as Uint8Array, outPath);
    } else if (format === 'usd') {
      // OpenUSD (.usda ASCII) — whole-model Z-up USD stage (geometry-backed).
      const out = gp.exportUsd(bytes);
      if (out == null) fatal('USD export failed (geometry pipeline not initialized)');
      await writeOutput(out as Uint8Array, outPath);
    } else if (format === 'step') {
      // Rust faithful re-serialization (+ reference-closed subset when filtered).
      const schema = getFlag(args, '--schema') ?? '';
      const out = gp.exportStep(bytes, schema, isolated);
      if (out == null) fatal('STEP export failed (geometry pipeline not initialized)');
      await writeOutput(out as Uint8Array, outPath);
    } else if (format === 'jsonld') {
      const out = gp.exportJsonld(bytes, '', true, false, false, isolated);
      if (out == null) fatal('JSON-LD export failed (geometry pipeline not initialized)');
      await writeOutput(out as Uint8Array, outPath);
    } else if (format === 'obj') {
      const out = gp.exportObj(bytes, true, new Uint32Array(), isolated);
      if (out == null) fatal('OBJ export failed (geometry pipeline not initialized)');
      await writeOutput(out as Uint8Array, outPath);
    } else {
      // gltf | glb → binary GLB
      if (!outPath) fatal('--out is required for GLB/glTF export (binary output)');
      let out: Uint8Array | null;
      try {
        out = gp.exportGlb(bytes, false, new Uint32Array(), isolated, '');
      } catch (err) {
        // The Rust boundary fails closed on an empty visible mesh set; map
        // the typed error to the tailored operator hint.
        if (isNoRenderGeometryError(err)) {
          fatal(
            filterActive
              ? 'GLB export produced 0 meshes — the matched entities have no exportable render geometry. Check --type/--storey/--where/--limit.'
              : 'GLB export produced 0 meshes — the model has no exportable render geometry (or geometry production failed).',
          );
        }
        throw err;
      }
      if (out == null) fatal('GLB export failed (geometry pipeline not initialized)');
      // Defense-in-depth behind the Rust fail-closed guard: a zero-mesh GLB
      // must never be written to disk and reported as success.
      if (countGlbMeshes(out as Uint8Array) === 0) {
        fatal(
          filterActive
            ? 'GLB export produced 0 meshes — the matched entities have no exportable render geometry. Check --type/--storey/--where/--limit.'
            : 'GLB export produced 0 meshes — the model has no exportable render geometry (or geometry production failed).',
        );
      }
      logger.debug(`GLB meshes: ${countGlbMeshes(out as Uint8Array)}`);
      await writeFile(outPath, out as Uint8Array);
      logger.info(`Written to ${outPath}`);
    }
    if (profileFlag) {
      process.stderr.write(
        `profile: ${format} export ${(performance.now() - tWork).toFixed(0)}ms\n`,
      );
    }
    // Opt-in geometry summary (--diagnostics, or implied by --verbose):
    // reuses the gp/bytes already in scope. This is a second geometry pass
    // (the export bindings do not return diagnostics yet), so it only runs
    // when asked for; the renderer is shared with diagnose-geometry.
    if (hasFlag(args, '--diagnostics') || logger.level() === 'debug') {
      if (format === 'ifcx') {
        logger.info('No geometry diagnostics for ifcx export (no mesh pass).');
      } else {
        // Best-effort: the export already succeeded; a diagnostics failure
        // must not turn it into a command failure.
        try {
          const diag = gp.diagnoseGeometry(bytes);
          logger.info(diag ? formatGeometryReport(diag) : NO_DIAGNOSTICS_LINE);
        } catch (err) {
          logger.warn(
            `Geometry diagnostics failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  } finally {
    gp.dispose();
  }
}
