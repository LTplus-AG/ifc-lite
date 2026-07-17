/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite simplify <file.ifc> --out light.ifc [--level 1..5] [--ids 1,2,3] [--json]
 *
 * Demesher (dev/testing surface for the DemeshSession SDK API): simplify
 * element meshes — levels 1-4 drop enclosed cavities and decimate to
 * 0.5/0.25/0.10/0.03 of the triangle count, level 5 collapses each element
 * to its bounding box — and write a lighter IFC where each simplified
 * element's representation is replaced by an IfcTriangulatedFaceSet.
 * `--level` defaults to 1; without --ids every element that produced a mesh
 * is simplified.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { getFlag, hasFlag, fatal, printJson } from '../output.js';
import { DemeshSession } from '@ifc-lite/export';

export async function simplifyCommand(args: string[]): Promise<void> {
  const filePath = args.find((a) => !a.startsWith('-'));
  if (!filePath) {
    fatal('Usage: ifc-lite simplify <file.ifc> --out light.ifc [--level 1..5] [--ids 1,2,3] [--json]');
  }
  const levelStr = getFlag(args, '--level');
  const outPath = getFlag(args, '--out');
  const idsStr = getFlag(args, '--ids');
  const jsonOutput = hasFlag(args, '--json');

  const level = Number(levelStr ?? '1');
  if (!Number.isInteger(level) || level < 1 || level > 5) {
    fatal('--level must be an integer 1..5 (1-4 = decimation tiers, 5 = bounding box; default 1)');
  }
  if (!outPath) fatal('--out is required. Specify output file path.');

  const source = new Uint8Array(await readFile(filePath!));
  const session = new DemeshSession(source);
  try {
    let ids: number[];
    if (idsStr) {
      // Strict: every token must be a positive decimal integer. parseInt
      // would silently accept '12foo' as 12, and filtering bad tokens away
      // would silently simplify a different selection than the user typed.
      const tokens = idsStr.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      if (tokens.length === 0 || tokens.some((s) => !/^\d+$/.test(s) || Number(s) < 1 || !Number.isSafeInteger(Number(s)))) {
        fatal('--ids must be a comma-separated list of positive integer express ids');
      }
      ids = tokens.map((s) => Number(s));
    } else {
      // Every element that produced geometry, heaviest first.
      ids = (await session.heaviest(Number.MAX_SAFE_INTEGER)).map((e) => e.expressId);
      if (ids.length === 0) fatal('No element meshes produced from this file.');
    }

    const simplified = await session.simplify(ids, level);
    if (simplified.elements.length === 0) {
      fatal(`No elements could be simplified (${simplified.skipped.length} skipped).`);
    }
    const exported = await session.exportIfc();
    // The export can still skip elements the mesh pass simplified (missing
    // representation attribute, no geometric context, ...). The exported
    // report is the authority on what the written IFC actually contains —
    // and when NOTHING was replaced there is no lighter file to write.
    const replaced = exported.report.replaced.length;
    if (replaced === 0) {
      fatal(
        `Simplified ${simplified.elements.length} meshes, but none could be applied to the IFC ` +
        `(${exported.report.skipped.length} skipped at export); not writing ${outPath}.`,
      );
    }
    await writeFile(outPath!, exported.bytes);

    const trisBefore = simplified.elements.reduce((s, e) => s + e.trisBefore, 0);
    const trisAfter = simplified.elements.reduce((s, e) => s + e.trisAfter, 0);
    if (jsonOutput) {
      printJson({
        level,
        simplified: simplified.elements.length,
        replaced,
        skipped: simplified.skipped,
        exportSkipped: exported.report.skipped,
        trianglesBefore: trisBefore,
        trianglesAfter: trisAfter,
        cavitiesDropped: simplified.elements.reduce((s, e) => s + e.cavitiesDropped, 0),
        prunedEntities: exported.report.prunedEntityCount,
        strippedOpenings: exported.report.strippedOpeningCount,
        upconverted: exported.upconverted,
        bytesBefore: exported.bytesBefore,
        bytesAfter: exported.bytesAfter,
        output: outPath,
      });
    } else {
      process.stderr.write(
        `Simplified ${simplified.elements.length} meshes at level ${level} ` +
        `(${simplified.skipped.length} skipped), ${replaced} representations replaced` +
        `${exported.report.skipped.length > 0 ? ` (${exported.report.skipped.length} skipped at export)` : ''}\n` +
        `Triangles: ${trisBefore} -> ${trisAfter}\n` +
        `File size: ${exported.bytesBefore} -> ${exported.bytesAfter} bytes` +
        `${exported.upconverted ? ' (upconverted IFC2X3 -> IFC4)' : ''}\n` +
        `Written to ${outPath}\n`,
      );
    }
  } finally {
    session.destroy();
  }
}
