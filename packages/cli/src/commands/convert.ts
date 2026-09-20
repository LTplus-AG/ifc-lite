/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite convert <file.ifc> --schema IFC4 --out <output.ifc>
 *
 * Convert an IFC file between schema versions.
 * Supports: IFC2X3, IFC4, IFC4X3, IFC5
 */

import { writeFile } from 'node:fs/promises';
import { loadIfcFile } from '../loader.js';
import { getFlag, hasFlag, fatal, printJson } from '../output.js';
import { exportToStep, analyzeConversionLoss, type IfcSchemaVersion } from '@ifc-lite/export';

const VALID_SCHEMAS = ['IFC2X3', 'IFC4', 'IFC4X3', 'IFC5'];

export async function convertCommand(args: string[]): Promise<void> {
  const filePath = args.find(a => !a.startsWith('-'));
  if (!filePath) fatal('Usage: ifc-lite convert <file.ifc> --schema IFC4 --out output.ifc');

  const targetSchema = getFlag(args, '--schema');
  if (!targetSchema) fatal('--schema is required (IFC2X3, IFC4, IFC4X3, IFC5)');
  if (!VALID_SCHEMAS.includes(targetSchema.toUpperCase())) {
    fatal(`Invalid schema: ${targetSchema}. Supported: ${VALID_SCHEMAS.join(', ')}`);
  }

  const outPath = getFlag(args, '--out');
  if (!outPath) fatal('--out is required for convert command');

  const jsonOutput = hasFlag(args, '--json');

  process.stderr.write(`Loading ${filePath}...\n`);
  const store = await loadIfcFile(filePath);
  const sourceSchema = (store.schemaVersion ?? 'IFC4') as IfcSchemaVersion;
  const targetSchemaVersion = targetSchema.toUpperCase() as IfcSchemaVersion;

  process.stderr.write(`Converting ${sourceSchema} → ${targetSchemaVersion}...\n`);

  // Computed before attempting the export (#4206): a store-level classification
  // of what every entity TYPE present will become, so a type this schema pair
  // cannot represent at all is reported by name and express id instead of
  // surfacing as an uncaught exception from the middle of `exportToStep` —
  // `analyzeConversionLoss` never throws and always covers the whole file.
  const lossReport = analyzeConversionLoss(store, sourceSchema, targetSchemaVersion);
  for (const line of lossReport.describe()) process.stderr.write(`  ${line}\n`);

  if (lossReport.hasBlocking) {
    fatal(
      `Cannot convert ${filePath} to ${targetSchemaVersion}: it contains entity types with no ${targetSchemaVersion} ` +
      'representation that are not IfcRoot subtypes, so they can neither be dropped nor replaced with a placeholder ' +
      '(see the entries logged above). Remove them before targeting this schema.',
    );
  }

  const content = exportToStep(store, { schema: targetSchemaVersion });

  await writeFile(outPath, content, 'utf-8');

  if (jsonOutput) {
    printJson({
      file: outPath,
      sourceSchema,
      targetSchema: targetSchemaVersion,
      fileSize: Buffer.byteLength(content, 'utf-8'),
      lossReport: lossReport.entries.map((e) => ({
        type: e.sourceType,
        targetType: e.targetType,
        kind: e.kind,
        count: e.count,
        expressIds: e.expressIds,
        droppedAttributes: e.droppedAttributes,
      })),
    });
  } else {
    process.stderr.write(`Converted to ${outPath} (${targetSchemaVersion})\n`);
  }
}
