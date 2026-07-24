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
 */

import { loadIfcFile } from '../loader.js';
import { hasFlag, fatal, printJson } from '../output.js';
import { EntityNode } from '@ifc-lite/query';
import { getInheritanceChainForEntity, type IfcDataStore } from '@ifc-lite/parser';

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
}

/**
 * Run the structural validation checks (required entities, storeys, GlobalId
 * uniqueness, naming, schema version, quantity completeness) against an
 * already-parsed store. Pulled out of {@link validateCommand} so other
 * callers (e.g. `ifc-lite gym`'s "schema" reward channel) reuse the exact
 * same rules instead of re-implementing them.
 */
export function computeValidationIssues(store: IfcDataStore): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // 1. Check required spatial entities
  const requiredTypes = ['IFCPROJECT', 'IFCSITE', 'IFCBUILDING'];
  for (const reqType of requiredTypes) {
    const ids = store.entityIndex.byType.get(reqType) ?? [];
    if (ids.length === 0) {
      issues.push({ severity: 'error', rule: 'required-entity', message: `Missing required entity: ${reqType}` });
    } else if (ids.length > 1 && reqType === 'IFCPROJECT') {
      issues.push({ severity: 'error', rule: 'single-project', message: `Multiple IfcProject entities found (${ids.length})` });
    }
  }

  // 2. Check storeys
  const storeyIds = store.entityIndex.byType.get('IFCBUILDINGSTOREY') ?? [];
  if (storeyIds.length === 0) {
    issues.push({ severity: 'warning', rule: 'has-storeys', message: 'No IfcBuildingStorey entities found' });
  }

  // 3. Check GlobalId uniqueness (only for entity types that inherit from IfcRoot)
  const globalIds = new Map<string, number[]>();
  for (const [typeName, ids] of store.entityIndex.byType) {
    const chain = getInheritanceChainForEntity(typeName);
    if (!chain.includes('IfcRoot')) continue;
    for (const id of ids) {
      const node = new EntityNode(store, id);
      const gid = node.globalId;
      if (gid) {
        const existing = globalIds.get(gid);
        if (existing) {
          existing.push(id);
        } else {
          globalIds.set(gid, [id]);
        }
      }
    }
  }
  const duplicateGlobalIds = [...globalIds.entries()].filter(([, ids]) => ids.length > 1);
  if (duplicateGlobalIds.length > 0) {
    issues.push({
      severity: 'error',
      rule: 'unique-globalid',
      message: `${duplicateGlobalIds.length} duplicate GlobalId(s) found`,
    });
  }

  // 4. Check for unnamed elements
  const productTypes = ['IFCWALL', 'IFCSLAB', 'IFCCOLUMN', 'IFCBEAM', 'IFCDOOR', 'IFCWINDOW',
    'IFCSTAIR', 'IFCROOF', 'IFCSPACE', 'IFCRAILING', 'IFCMEMBER', 'IFCPLATE', 'IFCFOOTING'];
  let unnamedCount = 0;
  for (const pt of productTypes) {
    const ids = store.entityIndex.byType.get(pt) ?? [];
    for (const id of ids) {
      const node = new EntityNode(store, id);
      if (!node.name || node.name === '' || node.name === '$') unnamedCount++;
    }
  }
  if (unnamedCount > 0) {
    issues.push({ severity: 'info', rule: 'named-elements', message: `${unnamedCount} building elements have no Name` });
  }

  // 5. Schema version
  if (!store.schemaVersion) {
    issues.push({ severity: 'warning', rule: 'schema-version', message: 'Could not determine IFC schema version' });
  }

  // 6. Quantity completeness — check if product entities have quantity sets
  const quantifiableTypes = ['IFCWALL', 'IFCSLAB', 'IFCCOLUMN', 'IFCBEAM', 'IFCDOOR', 'IFCWINDOW',
    'IFCSTAIR', 'IFCROOF', 'IFCSPACE', 'IFCMEMBER', 'IFCPLATE', 'IFCFOOTING',
    'IFCWALLSTANDARDCASE', 'IFCSLABSTANDARDCASE', 'IFCBEAMSTANDARDCASE',
    'IFCCOLUMNSTANDARDCASE', 'IFCDOORSTANDARDCASE', 'IFCWINDOWSTANDARDCASE'];
  let withQuantities = 0;
  let withoutQuantities = 0;
  for (const qt of quantifiableTypes) {
    const ids = store.entityIndex.byType.get(qt) ?? [];
    for (const id of ids) {
      const node = new EntityNode(store, id);
      const qsets = node.quantities();
      if (qsets.length > 0) {
        withQuantities++;
      } else {
        withoutQuantities++;
      }
    }
  }
  const totalQuantifiable = withQuantities + withoutQuantities;
  if (totalQuantifiable > 0 && withoutQuantities > 0) {
    const pct = Math.round((withoutQuantities / totalQuantifiable) * 100);
    issues.push({
      severity: pct > 50 ? 'warning' : 'info',
      rule: 'quantity-completeness',
      message: `${withoutQuantities}/${totalQuantifiable} building elements (${pct}%) have no quantity sets — quantity-based analysis may be incomplete`,
    });
  }

  return issues;
}

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
