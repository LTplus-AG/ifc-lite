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
 */

import { loadIfcFile } from '../loader.js';
import { hasFlag, fatal, printJson } from '../output.js';
import { EntityNode } from '@ifc-lite/query';
import { getInheritanceChainForEntity, type IfcDataStore, type EntityRef } from '@ifc-lite/parser';

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
  /** Referencing entity's expressId (set by per-reference rules like reference-integrity). */
  entityId?: number;
  /** Zero-based top-level attribute slot of the offending value within the referencing entity. */
  attributeIndex?: number;
  /** The referenced expressId that does not exist in the file. */
  target?: number;
}

/** One `#N` reference whose target expressId does not exist in the file. */
interface DanglingReference {
  /** expressId of the entity containing the reference. */
  entityId: number;
  /** STEP type name of the referencing entity (UPPERCASE, as scanned). */
  entityType: string;
  /** Zero-based top-level attribute slot the reference sits in (nested refs report their containing slot). */
  attributeIndex: number;
  /** The missing expressId being referenced. */
  target: number;
}

/** Cap on individually-reported dangling references; the remainder is rolled into one summary issue. */
const DANGLING_REF_ISSUE_CAP = 50;

const CH_QUOTE = 0x27; // '
const CH_LPAREN = 0x28; // (
const CH_RPAREN = 0x29; // )
const CH_COMMA = 0x2c; // ,
const CH_HASH = 0x23; // #
const CH_SLASH = 0x2f; // /
const CH_STAR = 0x2a; // *

/**
 * Scan one entity record's source bytes for `#N` attribute references and
 * report the ones whose target expressId is not indexed. Operates directly on
 * the raw bytes the parser already indexed (`store.entityIndex.byId` spans),
 * so it is a single pass over each record with no string allocation. Quote
 * tracking (including STEP's doubled-quote escape) keeps `#N` sequences inside
 * string literals from being read as references; embedded STEP comments are
 * skipped.
 */
function scanEntityForDanglingRefs(
  source: Uint8Array,
  ref: EntityRef,
  exists: (id: number) => boolean,
  out: DanglingReference[],
): void {
  const end = ref.byteOffset + ref.byteLength;
  // References only occur inside the attribute list; skip the "#id = TYPE" prefix.
  let i = ref.byteOffset;
  while (i < end && source[i] !== CH_LPAREN) i++;
  if (i >= end) return; // malformed record, nothing to scan

  let depth = 1; // we are inside the outermost '(' now
  let attrIndex = 0;
  i++;

  while (i < end) {
    const c = source[i];
    if (c === CH_QUOTE) {
      // String literal: skip to the closing quote, honouring '' escapes.
      i++;
      while (i < end) {
        if (source[i] === CH_QUOTE) {
          if (i + 1 < end && source[i + 1] === CH_QUOTE) {
            i += 2; // escaped quote, still inside the string
            continue;
          }
          break; // closing quote
        }
        i++;
      }
    } else if (c === CH_SLASH && i + 1 < end && source[i + 1] === CH_STAR) {
      // STEP comment inside a record (rare but legal): skip to closing marker.
      i += 2;
      while (i + 1 < end && !(source[i] === CH_STAR && source[i + 1] === CH_SLASH)) i++;
      i++; // lands on '/', loop increment moves past it
    } else if (c === CH_LPAREN) {
      depth++;
    } else if (c === CH_RPAREN) {
      depth--;
      if (depth === 0) return; // end of attribute list
    } else if (c === CH_COMMA && depth === 1) {
      attrIndex++;
    } else if (c === CH_HASH) {
      let id = 0;
      let digits = 0;
      let j = i + 1;
      while (j < end) {
        const d = source[j] - 0x30;
        if (d < 0 || d > 9) break;
        id = id * 10 + d;
        digits++;
        j++;
      }
      if (digits > 0) {
        if (!exists(id)) {
          out.push({ entityId: ref.expressId, entityType: ref.type, attributeIndex: attrIndex, target: id });
        }
        i = j - 1; // loop increment moves past the last digit
      }
    }
    i++;
  }
}

/**
 * Walk every indexed entity record and collect `#N` references whose target
 * does not exist in the file (rule `reference-integrity`). Uses the parsed
 * entity index for both iteration and existence checks; entities held in the
 * deferred index (lazily-parsed property entities) count as existing and are
 * scanned too.
 */
export function collectDanglingReferences(store: IfcDataStore): DanglingReference[] {
  const source = store.source;
  const byId = store.entityIndex.byId;
  const deferred = store.deferredEntityIndex;
  if (!source || source.byteLength === 0 || !byId) return [];

  const exists = (id: number): boolean => byId.has(id) || deferred?.has(id) === true;

  const out: DanglingReference[] = [];
  for (const ref of byId.values()) {
    scanEntityForDanglingRefs(source, ref, exists, out);
  }
  if (deferred) {
    for (const ref of deferred.values()) {
      if (byId.has(ref.expressId)) continue; // already scanned above
      scanEntityForDanglingRefs(source, ref, exists, out);
    }
  }
  return out;
}

/**
 * Run the structural validation checks (required entities, storeys, GlobalId
 * uniqueness, naming, schema version, quantity completeness, reference
 * integrity) against an already-parsed store. Pulled out of
 * {@link validateCommand} so other consumers (tests, harnesses) reuse the
 * exact same rules instead of re-implementing them.
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

  // 7. Reference integrity: every #N attribute reference must resolve to an
  // entity that exists in the file. A dangling reference is structurally
  // broken data (consumers following it get nothing, or worse, garbage), so
  // it reports as an error like unique-globalid does.
  const dangling = collectDanglingReferences(store);
  for (const d of dangling.slice(0, DANGLING_REF_ISSUE_CAP)) {
    // Display names render in IFC PascalCase (IfcWall, not IFCWALL); the
    // collector carries the raw STEP token, so resolve through the table.
    const typeName = store.entities.getTypeName(d.entityId) || d.entityType;
    issues.push({
      severity: 'error',
      rule: 'reference-integrity',
      message: `#${d.entityId} ${typeName} attribute ${d.attributeIndex} references missing entity #${d.target}`,
      entityId: d.entityId,
      attributeIndex: d.attributeIndex,
      target: d.target,
    });
  }
  if (dangling.length > DANGLING_REF_ISSUE_CAP) {
    issues.push({
      severity: 'error',
      rule: 'reference-integrity',
      message: `${dangling.length - DANGLING_REF_ISSUE_CAP} more dangling reference(s) not listed (${dangling.length} total)`,
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
