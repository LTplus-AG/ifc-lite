/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite ids <file.ifc> <rules.ids> [options]
 *
 * Validate an IFC file against IDS (Information Delivery Specification) rules.
 */

import { readFile } from 'node:fs/promises';
import { createHeadlessContext } from '../loader.js';
import { printJson, hasFlag, getFlag, fatal } from '../output.js';
import { createDataAccessor } from '@ifc-lite/ids/bridge';

interface ValidatorSummary {
  totalSpecifications: number;
  passedSpecifications: number;
  failedSpecifications: number;
  totalEntitiesChecked: number;
  totalEntitiesPassed: number;
  totalEntitiesFailed: number;
  overallPassRate: number;
}

export async function idsCommand(args: string[]): Promise<void> {
  const positional = args.filter(a => !a.startsWith('-'));
  if (positional.length < 2) fatal('Usage: ifc-lite ids <file.ifc> <rules.ids> [--json]');

  const [ifcPath, idsPath] = positional;
  const jsonOutput = hasFlag(args, '--json');
  const locale = (getFlag(args, '--locale') ?? 'en') as 'en' | 'de' | 'fr';

  const { bim, store } = await createHeadlessContext(ifcPath);

  // Read IDS file
  const idsContent = await readFile(idsPath, 'utf-8');

  // Parse and validate
  const idsDoc = await bim.ids.parse(idsContent);

  // The shared bridge accessor is the canonical IfcDataStore →
  // IFCDataAccessor projection (same one the viewer and MCP server use).
  const accessor = createDataAccessor(store);

  const report = (await bim.ids.validate(idsDoc, {
    accessor,
    modelInfo: { schemaVersion: store.schemaVersion },
    locale,
    // For human-readable output only the failures matter; dropping
    // passing entity results keeps the report bounded on large models.
    includePassingEntities: jsonOutput,
    onProgress: (p) => {
      if (!jsonOutput && p.phase !== 'complete') {
        const spec = Math.min(p.specificationIndex + 1, p.totalSpecifications);
        process.stderr.write(`\r  Validating: spec ${spec}/${p.totalSpecifications} (${p.percentage}%)`);
      }
    },
  })) as {
    summary: ValidatorSummary;
    specificationResults: Array<{ entityResults: Array<{ passed: boolean }> }>;
  };

  if (!jsonOutput) process.stderr.write('\n');

  if (jsonOutput) {
    // Keep the established machine-readable summary shape.
    const summary = bim.ids.summarize(report);
    printJson({ summary, report });
    return;
  }

  // The validator computes its summary from full per-spec counts, so it
  // stays correct even though passing entity results are not retained.
  const summary = report.summary;

  process.stdout.write(`\n  IDS Validation Results\n`);
  process.stdout.write(`  ─────────────────────\n`);
  process.stdout.write(`  Specifications: ${summary.passedSpecifications}/${summary.totalSpecifications} passed\n`);
  process.stdout.write(`  Entities:       ${summary.totalEntitiesPassed}/${summary.totalEntitiesChecked} passed\n`);
  process.stdout.write(`  Failed:         ${summary.totalEntitiesFailed} entities in ${summary.failedSpecifications} specs\n`);

  const exitCode = summary.failedSpecifications > 0 ? 1 : 0;
  process.stdout.write(`\n  Result: ${exitCode === 0 ? 'PASS' : 'FAIL'}\n\n`);
  process.exitCode = exitCode;
}
