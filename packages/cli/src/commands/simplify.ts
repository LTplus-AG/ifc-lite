/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite simplify <file.ifc> --level 1..5 --out light.ifc [--ids 1,2,3] [--json]
 *
 * Demesher (dev/testing surface for the DemeshSession SDK API): simplify
 * element meshes — levels 1-4 drop enclosed cavities and decimate to
 * 0.5/0.25/0.10/0.03 of the triangle count, level 5 collapses each element
 * to its bounding box — and write a lighter IFC where each simplified
 * element's representation is replaced by an IfcTriangulatedFaceSet.
 * Without --ids every element that produced a mesh is simplified.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { getFlag, hasFlag, fatal, printJson } from '../output.js';
import { DemeshSession } from '@ifc-lite/export';

export async function simplifyCommand(args: string[]): Promise<void> {
  const filePath = args.find((a) => !a.startsWith('-'));
  if (!filePath) {
    fatal('Usage: ifc-lite simplify <file.ifc> --level 1..5 --out light.ifc [--ids 1,2,3] [--json]');
  }
  const levelStr = getFlag(args, '--level');
  const outPath = getFlag(args, '--out');
  const idsStr = getFlag(args, '--ids');
  const jsonOutput = hasFlag(args, '--json');

  const level = parseInt(levelStr ?? '1', 10);
  if (!Number.isInteger(level) || level < 1 || level > 5) {
    fatal('--level must be an integer 1..5 (1-4 = decimation tiers, 5 = bounding box)');
  }
  if (!outPath) fatal('--out is required. Specify output file path.');

  const source = new Uint8Array(await readFile(filePath!));
  const session = new DemeshSession(source);
  try {
    let ids: number[];
    if (idsStr) {
      ids = idsStr.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length === 0) fatal('--ids must be a comma-separated list of express ids');
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
    await writeFile(outPath!, exported.bytes);

    const trisBefore = simplified.elements.reduce((s, e) => s + e.trisBefore, 0);
    const trisAfter = simplified.elements.reduce((s, e) => s + e.trisAfter, 0);
    if (jsonOutput) {
      printJson({
        level,
        simplified: simplified.elements.length,
        skipped: simplified.skipped,
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
        `Simplified ${simplified.elements.length} elements at level ${level} ` +
        `(${simplified.skipped.length} skipped)\n` +
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
