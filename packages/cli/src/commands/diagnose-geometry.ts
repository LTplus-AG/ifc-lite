// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `ifc-lite diagnose-geometry <file.ifc>` - run geometry extraction and report
 * its CSG / opening diagnostics (the `GeometryDiagnostics` contract): opening
 * classification, per-reason failure breakdown, silent rectangular no-ops,
 * rect_fast fast-path engagement, and the worst-failing hosts. The same contract
 * the viewer surfaces on the streaming `complete` event and the server attaches to
 * `ProcessingStats.geometry_diagnostics`. Use `--json` for the raw object.
 *
 * `--product <expressId|GlobalId>` and `--type <IfcType>` narrow the
 * `worstHosts` detail list (the ONLY per-product records this contract
 * carries — a bounded top-N of hosts that recorded a CSG failure; aggregate
 * counts always describe the whole file, filters only narrow which
 * per-product rows are shown/printed).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { GeometryProcessor, type GeometryDiagnostics } from '@ifc-lite/geometry';
import { getFlag, hasFlag, fatal } from '../output.js';
import { logger } from '../logger.js';
import { loadIfcBytes } from '../loader.js';
import { formatGeometryReport, NO_DIAGNOSTICS_LINE } from '../geometry-report.js';

type WorstHost = GeometryDiagnostics['worstHosts'][number];

/** True for a bare STEP express ID ("42"), false for a GlobalId ("0YvCT2..."). */
export function isExpressId(raw: string): boolean {
  return /^\d+$/.test(raw);
}

/**
 * Narrow the bounded `worstHosts` list to a single product and/or IFC type.
 * Pure so it's directly unit-testable without a wasm/model round-trip.
 */
export function filterWorstHosts(
  hosts: WorstHost[],
  opts: { productId?: number; ifcType?: string },
): WorstHost[] {
  return hosts.filter((h) => {
    if (opts.productId !== undefined && h.productId !== opts.productId) return false;
    if (opts.ifcType && h.ifcType !== opts.ifcType) return false;
    return true;
  });
}

export async function diagnoseGeometryCommand(args: string[]): Promise<void> {
  const filePath = args.find((a) => !a.startsWith('-'));
  if (!filePath) {
    fatal(
      'Usage: ifc-lite diagnose-geometry <file.ifc> [--json] [--out file.json] ' +
        '[--product <expressId|GlobalId>] [--type <IfcType>]',
    );
    return;
  }
  const asJson = hasFlag(args, '--json');
  const outPath = getFlag(args, '--out');
  const productArg = getFlag(args, '--product');
  const typeArg = getFlag(args, '--type');

  const buf = await readFile(filePath);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

  const gp = new GeometryProcessor();
  await gp.init();
  let diag = gp.diagnoseGeometry(bytes);

  if (diag && (productArg !== undefined || typeArg !== undefined)) {
    let productId: number | undefined;
    if (productArg !== undefined) {
      if (isExpressId(productArg)) {
        productId = parseInt(productArg, 10);
      } else {
        // GlobalId: resolve via the columnar parser's entity table (the wasm
        // diagnostics pass never surfaces GlobalIds, only express IDs). Parse
        // the bytes ALREADY in memory rather than re-reading the file from disk
        // — the geometry pass above already loaded them, so this avoids a
        // redundant disk read (the wasm IfcAPI exposes no GlobalId lookup, so a
        // columnar parse is still required to map GlobalId → expressId).
        const store = await loadIfcBytes(bytes, filePath);
        const resolved = store.entities.getExpressIdByGlobalId(productArg);
        if (resolved === -1) {
          fatal(`--product: no entity found with GlobalId "${productArg}"`);
          return;
        }
        productId = resolved;
      }
    }
    diag = { ...diag, worstHosts: filterWorstHosts(diag.worstHosts, { productId, ifcType: typeArg }) };
  }

  if (asJson || outPath) {
    const json = JSON.stringify(diag ?? null, null, 2);
    if (outPath) {
      await writeFile(outPath, json);
      logger.info(`Wrote diagnostics to ${outPath}`);
    } else {
      process.stdout.write(json + '\n');
    }
    return;
  }

  if (!diag) {
    process.stdout.write(NO_DIAGNOSTICS_LINE + '\n');
    return;
  }
  // Always print the full aggregate report — `formatGeometryReport` renders the
  // file-wide counts (totalCsgFailures, failuresByReason, classification, …)
  // and handles an empty `worstHosts` list gracefully. When a --product/--type
  // filter narrowed the list to nothing we append a note rather than hiding the
  // aggregate context behind a bare "no match" line (PR #1564 review).
  const report = formatGeometryReport(diag);
  if ((productArg !== undefined || typeArg !== undefined) && diag.worstHosts.length === 0) {
    process.stdout.write(
      report +
        '\n\n' +
        '(No worst-failing host record matches --product/--type — diagnose-geometry ' +
        'only tracks the bounded top-N hosts that recorded a CSG failure; a filtered-out ' +
        'product may simply have none.)\n',
    );
    return;
  }
  process.stdout.write(report + '\n');
}
