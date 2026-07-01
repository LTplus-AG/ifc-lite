/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite merge <file1.ifc> <file2.ifc> [...] --out <merged.ifc>
 *
 * Merge multiple IFC files into a single file.
 * Spatial hierarchy (storeys, buildings) is unified by name/elevation.
 */

import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadIfcFile } from '../loader.js';
import { getFlag, hasFlag, fatal, printJson } from '../output.js';

const UNIT_RECONCILIATION_MODES = ['auto', 'normalize', 'assume-shared'] as const;
type UnitReconciliation = typeof UNIT_RECONCILIATION_MODES[number];

export async function mergeCommand(args: string[]): Promise<void> {
  const outPath = getFlag(args, '--out');
  if (!outPath) fatal('--out is required: ifc-lite merge <file1.ifc> <file2.ifc> --out merged.ifc');

  const schema = getFlag(args, '--schema') as 'IFC2X3' | 'IFC4' | 'IFC4X3' | undefined;
  const jsonOutput = hasFlag(args, '--json');

  // How to reconcile models whose length unit differs from the first file's.
  // 'auto' (default) federates them as separate projects; 'normalize' rescales
  // them into the first file's unit for one single-unit project; 'assume-shared'
  // forces one project without rescaling.
  const unitReconciliation = (getFlag(args, '--unit-reconciliation') ?? 'auto') as UnitReconciliation;
  if (!UNIT_RECONCILIATION_MODES.includes(unitReconciliation)) {
    fatal(`--unit-reconciliation must be one of: ${UNIT_RECONCILIATION_MODES.join(', ')}`);
  }

  // Collect all positional args as input files
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) {
      if (args[i] === '--out' || args[i] === '--schema' || args[i] === '--unit-reconciliation') i++; // skip value
      continue;
    }
    files.push(args[i]);
  }

  if (files.length < 2) fatal('At least 2 IFC files are required for merge');

  process.stderr.write(`Loading ${files.length} files...\n`);

  const models = [];
  for (let i = 0; i < files.length; i++) {
    const store = await loadIfcFile(files[i]);
    models.push({
      id: `model-${i}`,
      name: basename(files[i]),
      dataStore: store,
    });
    process.stderr.write(`  Loaded ${files[i]} (${store.entityCount} entities)\n`);
  }

  // Dynamic import to avoid loading the exporter unless needed
  const { MergedExporter } = await import('@ifc-lite/export');
  const exporter = new MergedExporter(models);
  const result = exporter.export({
    schema: (schema ?? 'IFC4') as 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5',
    unitReconciliation,
  });

  await writeFile(outPath, result.content, 'utf-8');

  if (jsonOutput) {
    printJson({
      file: outPath,
      modelCount: result.stats.modelCount,
      totalEntityCount: result.stats.totalEntityCount,
      fileSize: result.stats.fileSize,
      federatedModelCount: result.stats.federatedModelCount,
      normalizedModelCount: result.stats.normalizedModelCount,
      warnings: result.stats.warnings,
    });
  } else {
    process.stderr.write(`Merged ${result.stats.modelCount} models → ${outPath} (${result.stats.totalEntityCount} entities)\n`);
    if (result.stats.normalizedModelCount > 0) {
      process.stderr.write(`Normalized ${result.stats.normalizedModelCount} model(s) into the first file's unit\n`);
    }
    for (const warning of result.stats.warnings) {
      process.stderr.write(`Warning: ${warning}\n`);
    }
  }
}
