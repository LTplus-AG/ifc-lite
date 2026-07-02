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
 */
import { readFile } from 'node:fs/promises';
import { GeometryProcessor, type GeometryDiagnostics } from '@ifc-lite/geometry';
import { getFlag, hasFlag, fatal } from '../output.js';

export async function diagnoseGeometryCommand(args: string[]): Promise<void> {
  const filePath = args.find((a) => !a.startsWith('-'));
  if (!filePath) {
    fatal('Usage: ifc-lite diagnose-geometry <file.ifc> [--json] [--out file.json]');
    return;
  }
  const asJson = hasFlag(args, '--json');
  const outPath = getFlag(args, '--out');

  const buf = await readFile(filePath);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

  const gp = new GeometryProcessor();
  await gp.init();
  const diag = gp.diagnoseGeometry(bytes);

  if (asJson || outPath) {
    const json = JSON.stringify(diag ?? null, null, 2);
    if (outPath) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(outPath, json);
      console.log(`Wrote diagnostics to ${outPath}`);
    } else {
      console.log(json);
    }
    return;
  }

  if (!diag) {
    console.log('No CSG / opening diagnostics recorded (no openings cut, no failures).');
    return;
  }
  printReport(diag);
}

function printReport(d: GeometryDiagnostics): void {
  const lines: string[] = [];
  lines.push('Geometry diagnostics');
  lines.push('====================');
  lines.push(
    `CSG failures:        ${d.totalCsgFailures} across ${d.productsWithFailures} product(s)`,
  );
  lines.push(`Hosts with openings: ${d.hostsWithOpenings}`);
  lines.push(
    `Openings classified: ${d.classification.total} ` +
      `(rectangular ${d.classification.rectangular}, diagonal ${d.classification.diagonal}, ` +
      `non-rectangular ${d.classification.nonRectangular})`,
  );
  lines.push(`Silent rect no-ops:  ${d.silentNoOps}`);

  if (d.failuresByReason.length > 0) {
    lines.push('');
    lines.push('Failures by reason:');
    for (const r of d.failuresByReason) {
      lines.push(`  ${r.count.toString().padStart(6)}  ${r.reason}`);
    }
  }

  const rf = d.rectFast;
  lines.push('');
  lines.push(
    `rect_fast: fired ${rf.fired}, openings cut ${rf.openingsCut} ` +
      `(defer: host-not-box ${rf.deferHostNotBox}, not-through ${rf.deferNotThrough}, ` +
      `off-face ${rf.deferOffFace}, near-edge ${rf.deferNearEdge}, no-openings ${rf.deferNoOpenings})`,
  );

  if (d.worstHosts.length > 0) {
    lines.push('');
    lines.push('Worst-failing hosts:');
    for (const h of d.worstHosts) {
      const label = h.firstFailureLabel ? ` [${h.firstFailureLabel}]` : '';
      lines.push(
        `  #${h.productId} ${h.ifcType}: ${h.csgFailures} failure(s), ${h.openings} opening(s)${label}`,
      );
    }
  }

  console.log(lines.join('\n'));
}
