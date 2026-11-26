/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EntityNode } from '@ifc-lite/query';
import { expandTypes, getInheritanceChainAcrossSchemas, structuralConsistencyReport, type IfcDataStore, type StructuralSkipReason, type StructuralSkippedMember } from '@ifc-lite/parser';
import { structuralPhysicalAxes } from '@ifc-lite/create';
import { resolvedTypeName } from '@ifc-lite/data';
import { collectDanglingReferences } from './validate-references.js';

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
  /** The entity the issue is about: the referencing entity for reference-integrity. */
  entityId?: number;
  /** GlobalId of `entityId`, set by the structural-consistency rules. */
  globalId?: string;
  /** Zero-based top-level attribute slot of the offending value within the referencing entity. */
  attributeIndex?: number;
  /** The other entity: the missing referenced id for reference-integrity, the linked physical element for structural-class-mismatch. */
  target?: number;
  /** GlobalId of `target`, when it exists. */
  targetGlobalId?: string;
}

/**
 * The building-element types the `named-elements` and `quantity-completeness`
 * rules scan, as base types only.
 *
 * Which base types appear here is a **policy** choice and deliberately narrow:
 * neither rule claims to cover every `IfcProduct`, and widening either list is
 * a decision about what the report should say, not a bug fix. The two lists are
 * not identical — `IfcRailing` is scanned for a missing Name but not for a
 * missing quantity set — and that asymmetry is preserved here unchanged.
 *
 * What is *not* a policy choice is whether a listed type's own concrete
 * subtypes are scanned. `entityIndex.byType` is keyed by the raw STEP type
 * name, so an `IfcWallStandardCase` sits in its own bucket; a rule that says it
 * looks at walls and reads only `IFCWALL` walks straight past it. That is why
 * the scanned lists below are `expandTypes(...)` of these bases rather than
 * hand-written: the quantity list used to spell six subtypes out by hand and
 * had drifted four short (`IfcWallElementedCase`, `IfcSlabElementedCase`,
 * `IfcMemberStandardCase`, `IfcPlateStandardCase`), and the naming list spelled
 * out none of the ten at all. `expandTypes` is the same expansion every
 * `byType()` backend uses, so these rules and a `byType('IfcWall')` query
 * cannot disagree about what counts as a wall.
 * Which is why they are computed PER STORE, not once at module load:
 * `expandTypes` reads the model's own `schemaVersion`, and a list frozen at the
 * IFC4 answer counts records on an IFC2X3 or IFC4X3 file that `byType` does not.
 */
export const NAMED_ELEMENT_BASE_TYPES: readonly string[] = ['IFCWALL', 'IFCSLAB', 'IFCCOLUMN', 'IFCBEAM',
  'IFCDOOR', 'IFCWINDOW', 'IFCSTAIR', 'IFCROOF', 'IFCSPACE', 'IFCRAILING', 'IFCMEMBER', 'IFCPLATE', 'IFCFOOTING'];

/** @see NAMED_ELEMENT_BASE_TYPES */
export const QUANTIFIABLE_BASE_TYPES: readonly string[] = ['IFCWALL', 'IFCSLAB', 'IFCCOLUMN', 'IFCBEAM',
  'IFCDOOR', 'IFCWINDOW', 'IFCSTAIR', 'IFCROOF', 'IFCSPACE', 'IFCMEMBER', 'IFCPLATE', 'IFCFOOTING'];

/** `NAMED_ELEMENT_BASE_TYPES` plus every subtype this store's schema declares under one. */
export const namedElementTypes = (schemaVersion: string | undefined): readonly string[] =>
  expandTypes([...NAMED_ELEMENT_BASE_TYPES], schemaVersion);

/** `QUANTIFIABLE_BASE_TYPES` plus every subtype this store's schema declares under one. */
export const quantifiableTypes = (schemaVersion: string | undefined): readonly string[] =>
  expandTypes([...QUANTIFIABLE_BASE_TYPES], schemaVersion);

/** Why a geometry rule passed over a member, as the end of a sentence. */
const SKIP_REASON: Record<StructuralSkipReason, string> = {
  'axis-unusable': 'the available axis data could not produce a usable measurement',
  'derivation-record-unreadable': 'its derivation record could not be read',
  'linked-element-identity-unreadable': 'a linked element has no readable GlobalId to match against its derivation record',
  'edge-unreadable': 'its edge could not be read',
  'no-derivation-record': 'it has no derivation record',
  'element-without-axis': 'no axis was read for its physical element',
  'recorded-element-unlinked': 'the element its derivation record names is no longer linked to it',
};

const onlyRecordMissing = ({ axisDrift, stale }: StructuralSkippedMember) => !axisDrift && stale === 'no-derivation-record';

/**
 * One `structural-unchecked-member` issue for a curve member the axis-drift or
 * movement rule did not compare. A warning, except when the only gap is a
 * missing derivation record.
 */
function uncheckedMember(member: StructuralSkippedMember): ValidationIssue {
  const { memberId, globalId, type, axisDrift, stale } = member;
  const parts = axisDrift === 'element-without-axis'
    ? [`movement and axis drift not checked: ${SKIP_REASON[axisDrift]}`]
    : [axisDrift && `axis drift not checked: ${SKIP_REASON[axisDrift]}`, stale && `movement not checked: ${SKIP_REASON[stale]}`].filter((part): part is string => !!part);
  return {
    severity: onlyRecordMissing(member) ? 'info' : 'warning',
    rule: 'structural-unchecked-member', entityId: memberId, globalId,
    message: `#${memberId} ${type}${globalId ? ` (${globalId})` : ''}: ${parts.join('; ')}`,
  };
}

/** Cap on individually-reported dangling references and unlinked load-bearing elements; the remainder is rolled into one summary issue. */
const ISSUE_LIST_CAP = 50;

/** Shared structural checks for a parsed store: required entities, storeys,
 * GlobalId uniqueness, naming, schema, quantities, reference integrity, and
 * (as warnings) physical vs structural analysis model consistency (#9668).
 * CLI validation, delivery, tests and harnesses all use these rules. */
export function computeValidationIssues(store: IfcDataStore): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // 1. Check required spatial entities
  const requiredTypes = ['IFCPROJECT', 'IFCSITE', 'IFCBUILDING'];
  for (const reqType of requiredTypes) {
    // @raw-entity-enumeration-ok CLI validation reads a freshly loaded file without a mutation view
    const ids = store.entityIndex.byType.get(reqType) ?? [];
    if (ids.length === 0) {
      issues.push({ severity: 'error', rule: 'required-entity', message: `Missing required entity: ${reqType}` });
    } else if (ids.length > 1 && reqType === 'IFCPROJECT') {
      issues.push({ severity: 'error', rule: 'single-project', message: `Multiple IfcProject entities found (${ids.length})` });
    }
  }

  // 2. Check storeys
  // @raw-entity-enumeration-ok structural validation reports the parsed file snapshot
  const storeyIds = store.entityIndex.byType.get('IFCBUILDINGSTOREY') ?? [];
  if (storeyIds.length === 0) {
    issues.push({ severity: 'warning', rule: 'has-storeys', message: 'No IfcBuildingStorey entities found' });
  }

  // 3. Check GlobalId uniqueness (only for entity types that inherit from IfcRoot)
  //
  // The chain has to come from **every bundled schema** (IFC2X3 + IFC4 +
  // IFC4X3), not from the parser's IFC4_ADD2_TC1 codegen pin (#2003).
  // `getInheritanceChainForEntity` answers an empty chain for any class the pin
  // does not carry, which made this rule quietly skip 39 IFC2X3 `IfcRoot`
  // classes (`IfcScheduleTimeControl`, `IfcSpaceProgram`, `IfcServiceLife`,
  // `IfcMove`, `IfcOrderAction`, `IfcTimeSeriesSchedule`, …), 80 IFC4X3 ones
  // and 4 post-ADD2 IFC4 ones. Skipping is not neutral here: it reports "no
  // duplicate GlobalIds" for a file it never looked at, and the user gets a
  // pass they did not earn.
  //
  // The membership test is `includes`, so it is indifferent to which end of the
  // chain the leaf sits at — and it has to be, because the two functions
  // disagree: the pinned one is root→leaf and the cross-schema one leaf→root,
  // so 717 of the 776 pinned classes get a different `chain[0]`. Anything
  // positional here would invert silently; match `diff-scope.ts` and search by
  // name instead. `packages/parser/test/inheritance-chain-equivalence.test.ts`
  // holds the measurement: over all 776, zero verdict and zero leaf-name
  // differences, so no IFC4 file changes behaviour.
  //
  // Non-`IfcRoot` types stay out for the reason they always did: the parser
  // fills slot 0 of a resource entity's record with its **Name**, so comparing
  // `IfcMaterial` or `IfcSurfaceStyle` here would report two same-named
  // materials as a duplicate GlobalId.
  const globalIds = new Map<string, number[]>();
  // @raw-entity-enumeration-ok GlobalId uniqueness is checked on the parsed file being validated
  for (const [typeName, ids] of store.entityIndex.byType) {
    const chain = getInheritanceChainAcrossSchemas(typeName);
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
  let unnamedCount = 0;
  for (const pt of namedElementTypes(store.schemaVersion)) {
    // @raw-entity-enumeration-ok naming validation scans the parsed file with no overlay
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
  let withQuantities = 0;
  let withoutQuantities = 0;
  for (const qt of quantifiableTypes(store.schemaVersion)) {
    // @raw-entity-enumeration-ok quantity completeness scans the parsed source file
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
  for (const d of dangling.slice(0, ISSUE_LIST_CAP)) {
    // Display names render in IFC PascalCase (IfcWall, not IFCWALL); the
    // collector carries the raw STEP token, so resolve through the table.
    const typeName = resolvedTypeName(store.entities, d.entityId) ?? d.entityType;
    issues.push({
      severity: 'error',
      rule: 'reference-integrity',
      message: `#${d.entityId} ${typeName} attribute ${d.attributeIndex} references missing entity #${d.target}`,
      entityId: d.entityId,
      attributeIndex: d.attributeIndex,
      target: d.target,
    });
  }
  if (dangling.length > ISSUE_LIST_CAP) {
    issues.push({
      severity: 'error',
      rule: 'reference-integrity',
      message: `${dangling.length - ISSUE_LIST_CAP} more dangling reference(s) not listed (${dangling.length} total)`,
    });
  }

  // 8. Where the physical and the structural analysis model disagree (#9668).
  // The two per-element rules are capped like dangling references; the others are listed in full.
  try {
    // Axis drift compares each member with its element's line, one shape read per element.
    // Read them only when the file has a curve member and a schema the reader supports.
    // @raw-entity-enumeration-ok class census of the parsed file; no attribute decoding
    const hasCurveMember = [...(store.entityIndex?.byType.keys() ?? [])].some((type) => /^ifcstructuralcurvemember/i.test(type));
    const physicalAxes = hasCurveMember && store.schemaVersion !== 'IFC5' ? structuralPhysicalAxes(store) : undefined;
    const { issues: structural, coverage } = structuralConsistencyReport(store, { physicalAxes });
    const capped = new Map([
      ['structural-unlinked-element', 'load-bearing element(s) with no structural item'],
      ['structural-unconnected-member', 'structural member(s) with no connection'],
    ]);
    for (const [rule, what] of capped) {
      const ofRule = structural.filter((issue) => issue.rule === rule);
      for (const issue of ofRule.slice(0, ISSUE_LIST_CAP)) issues.push(issue);
      if (ofRule.length > ISSUE_LIST_CAP) {
        issues.push({ severity: 'warning', rule, message: `${ofRule.length - ISSUE_LIST_CAP} more ${what} not listed (${ofRule.length} total)` });
      }
    }
    for (const issue of structural) if (!capped.has(issue.rule)) issues.push(issue);
    // No finding is not a pass for the members the geometry rules passed over: say how many, then which.
    const { linked, skipped } = coverage;
    if (skipped.length > 0) {
      issues.push({
        severity: 'info', rule: 'structural-unchecked-member',
        message: `Movement or axis drift was not checked on ${skipped.length} of ${linked} linked curve member(s)`,
      });
      issues.push(...skipped.slice(0, ISSUE_LIST_CAP).map(uncheckedMember));
      if (skipped.length > ISSUE_LIST_CAP) {
        issues.push({ severity: skipped.slice(ISSUE_LIST_CAP).every(onlyRecordMissing) ? 'info' : 'warning', rule: 'structural-unchecked-member', message: `${skipped.length - ISSUE_LIST_CAP} more unchecked curve member(s) not listed (${skipped.length} total)` });
      }
    }
  } catch (err) {
    issues.push({ severity: 'warning', rule: 'structural-consistency', message: `Structural consistency checks could not run: ${err instanceof Error ? err.message : String(err)}` });
  }

  return issues;
}
