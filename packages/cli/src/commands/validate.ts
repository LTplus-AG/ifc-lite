/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite validate <file.ifc> [--json]
 *
 * Perform structural validation checks on an IFC file:
 * - Schema version detection
 * - Required entity presence (IfcProject, IfcSite, IfcBuilding)
 * - Spatial structure completeness
 * - Orphan entity detection
 * - GlobalId uniqueness
 * - Reference integrity (#N references that point at no entity)
 * - Physical vs structural analysis model consistency (#9668)
 */

import { loadIfcFile } from '../loader.js';
import { hasFlag, fatal, printJson } from '../output.js';
import { computeValidationIssues } from '@ifc-lite/sdk/headless/delivery';
export { computeValidationIssues, namedElementTypes, quantifiableTypes, NAMED_ELEMENT_BASE_TYPES, QUANTIFIABLE_BASE_TYPES, type ValidationIssue } from '@ifc-lite/sdk/headless/delivery';

export async function validateCommand(args: string[]): Promise<void> {
  const filePath = args.find(a => !a.startsWith('-'));
  if (!filePath) fatal('Usage: ifc-lite validate <file.ifc> [--json]');

  const jsonOutput = hasFlag(args, '--json');

  const store = await loadIfcFile(filePath);
  const issues = computeValidationIssues(store);

  const summary = {
    file: filePath,
    schema: store.schemaVersion,
    entityCount: store.entityCount,
    valid: issues.filter(i => i.severity === 'error').length === 0,
    errors: issues.filter(i => i.severity === 'error').length,
    warnings: issues.filter(i => i.severity === 'warning').length,
    info: issues.filter(i => i.severity === 'info').length,
    issues,
  };

  if (jsonOutput) {
    printJson(summary);
  } else {
    const status = summary.valid ? 'VALID' : 'INVALID';
    process.stdout.write(`\n  ${status}: ${filePath}\n`);
    process.stdout.write(`  Schema: ${store.schemaVersion ?? 'unknown'}\n`);
    process.stdout.write(`  Entities: ${store.entityCount}\n\n`);
    for (const issue of issues) {
      const icon = issue.severity === 'error' ? 'ERR' : issue.severity === 'warning' ? 'WRN' : 'INF';
      process.stdout.write(`  [${icon}] ${issue.rule}: ${issue.message}\n`);
    }
    process.stdout.write(`\n  ${summary.errors} error(s), ${summary.warnings} warning(s), ${summary.info} info\n\n`);
  }

  if (!summary.valid) process.exitCode = 1;
}
