/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite lod <file.ifc> --level 0|1 [options]
 *
 * Generate lightweight LOD artifacts from an IFC file.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { generateLod0, generateLod1 } from '@ifc-lite/export';
import { getFlag, hasFlag, fatal, printJson, writeOutput } from '../output.js';

type LodLevel = '0' | '1';

function inferMetaPath(outPath: string): string {
  const ext = extname(outPath);
  if (!ext) return `${outPath}.json`;
  return `${outPath.slice(0, -ext.length)}.lod1.json`;
}

function parseLevel(value: string | undefined): LodLevel {
  const level = value ?? '1';
  if (level !== '0' && level !== '1') {
    fatal(`Invalid --level "${level}". Supported levels: 0, 1`);
  }
  return level;
}

export async function lodCommand(args: string[]): Promise<void> {
  const filePath = args.find(arg => !arg.startsWith('-'));
  if (!filePath) {
    fatal('Usage: ifc-lite lod <file.ifc> --level 0|1 [--out file] [--meta file] [--json]');
  }

  const level = parseLevel(getFlag(args, '--level'));
  const outPath = getFlag(args, '--out');
  const metaPath = getFlag(args, '--meta');
  const jsonOutput = hasFlag(args, '--json');

  const input = await readFile(filePath);
  const bytes = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;

  if (level === '0') {
    const lod0 = await generateLod0(bytes);
    const content = JSON.stringify(lod0, null, 2);

    if (outPath) await writeOutput(content, outPath);
    else process.stdout.write(content + '\n');

    if (jsonOutput) {
      printJson({
        level: 0,
        file: filePath,
        output: outPath ?? null,
        elementCount: lod0.elements.length,
      });
    } else {
      process.stderr.write(`Generated LOD0 for ${lod0.elements.length} elements\n`);
    }
    return;
  }

  if (!outPath) {
    fatal('--out is required for LOD1 output');
  }

  const result = await generateLod1(bytes);
  const resolvedMetaPath = metaPath ?? inferMetaPath(outPath);

  await writeFile(outPath, result.glb);
  await writeFile(resolvedMetaPath, JSON.stringify(result.meta, null, 2), 'utf-8');

  if (jsonOutput) {
    printJson({
      level: 1,
      file: filePath,
      output: outPath,
      meta: resolvedMetaPath,
      status: result.meta.status,
      failedElements: result.meta.failedElements.length,
    });
  } else {
    process.stderr.write(
      `Generated LOD1 GLB → ${outPath} (${result.meta.status}, ${result.meta.failedElements.length} failed elements)\n`,
    );
    process.stderr.write(`Generated LOD1 metadata → ${resolvedMetaPath}\n`);
  }
}
