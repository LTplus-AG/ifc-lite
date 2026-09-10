/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cost (5D) extractor — parses IfcCostItem, IfcCostValue, IfcCostSchedule,
 * IfcRelNests and IfcRelAssignsToControl from a parsed IfcDataStore into a
 * normalized CostExtraction. Structure mirrors `schedule-extractor.ts`
 * (schedule/task hierarchy -> cost/cost-item hierarchy).
 *
 * Relationship wiring, verified against `packages/codegen/schemas/IFC4_ADD2_TC1.exp`
 * / `IFC4X3.exp` (identical in both):
 *
 *  - `IfcControl` (the supertype of both `IfcCostItem` and `IfcCostSchedule`)
 *    declares `INVERSE Controls : SET [0:?] OF IfcRelAssignsToControl FOR
 *    RelatingControl` — `IfcRelAssignsToControl` is the ONLY relationship
 *    that can target a Control as `RelatingControl`, so it is necessarily
 *    what binds both "schedule controls cost items" and "cost item controls
 *    the objects it prices" — there is no separate relationship analogous to
 *    `IfcRelAssignsToProcess` for cost. Which of the two a given
 *    `IfcRelAssignsToControl` instance expresses is told apart here by
 *    what its `RelatingControl` expressId resolves to (a cost schedule or
 *    a cost item), not by anything the schema itself distinguishes.
 *  - Cost item breakdown (parent/child `IfcCostItem` nesting) uses
 *    `IfcRelNests` (`RelatingObject`/`RelatedObjects : IfcObjectDefinition`,
 *    which `IfcCostItem` satisfies via `IfcControl -> IfcObject ->
 *    IfcObjectDefinition`) — the same relationship `schedule-extractor.ts`
 *    uses for task hierarchy. The EXPRESS schema does not constrain this by
 *    a WHERE rule (nothing stops `IfcRelNests` from nesting unrelated
 *    objects), so this is the domain convention this extractor follows, not
 *    a schema-enforced fact — reported explicitly rather than asserted as
 *    certain.
 *
 * IFC2X3's `IfcCostItem` has NO attributes at all (`SUBTYPE OF (IfcControl)`
 * only — no PredefinedType/CostValues/CostQuantities), so those fields are
 * always `undefined` for a 2X3 file; this is schema-version-gated below, not
 * inferred from an empty read.
 */

import { EntityExtractor } from './entity-extractor.js';
import type { IfcDataStore } from './columnar-parser.js';
import { collectQuantitiesFromRefs } from './quantity-collect.js';
import type { CostExtraction, CostItemInfo, CostScheduleInfo, CostValueInfo } from './cost-types.js';

/** Flattened IFC4/IFC4X3 STEP attribute indices for IfcCostItem. */
const COST_ITEM_ATTR = {
  GlobalId: 0,
  Name: 2,
  Description: 3,
  ObjectType: 4,
  Identification: 5,
  PredefinedType: 6,
  CostValues: 7,
  CostQuantities: 8,
} as const;

const COST_SCHEDULE_ATTR = {
  GlobalId: 0,
  Name: 2,
  Description: 3,
  ObjectType: 4,
  Identification: 5,
  PredefinedType: 6,
  Status: 7,
  SubmittedOn: 8,
  UpdateDate: 9,
} as const;

/** IfcAppliedValue attribute slots (IfcCostValue adds no attributes of its own). */
const COST_VALUE_ATTR = {
  Name: 0,
  Description: 1,
  AppliedValue: 2,
  ApplicableDate: 4,
  FixedUntilDate: 5,
  Category: 6,
  Condition: 7,
  ArithmeticOperator: 8,
  Components: 9,
} as const;

const REL_NESTS_ATTR = { RelatingObject: 4, RelatedObjects: 5 } as const;
const REL_ASSIGNS_TO_CONTROL_ATTR = { RelatedObjects: 4, RelatingControl: 6 } as const;

function asString(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}

function asEnum(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined;
  const match = v.match(/^\.([A-Z_]+)\.$/);
  return match ? match[1] : undefined;
}

function asRef(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  return undefined;
}

function asRefList(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    const id = asRef(x);
    if (id !== undefined) out.push(id);
  }
  return out;
}

/**
 * `AppliedValue` is an `IfcAppliedValueSelect`. A resolved measure reads as a
 * typed pair `['IFCMONETARYMEASURE', 500]` (same shape `extractLagTimeSeconds`
 * in `schedule-extractor.ts` unwraps for `IfcTimeOrRatioSelect`); a plain
 * number is accepted too, since not every parse path wraps a select. Any
 * other select member (e.g. a table or measure-with-unit reference) is left
 * unresolved rather than guessed at.
 */
function asAppliedValueNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v) && v.length === 2) {
    const inner = v[1];
    if (typeof inner === 'number' && Number.isFinite(inner)) return inner;
    if (typeof inner === 'string') {
      const n = parseFloat(inner);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

const MAX_COST_VALUE_DEPTH = 20;

function extractCostValue(
  extractor: EntityExtractor,
  store: IfcDataStore,
  valueId: number,
  depth: number,
  visiting: Set<number>,
): CostValueInfo | undefined {
  if (depth > MAX_COST_VALUE_DEPTH || visiting.has(valueId)) return undefined;
  const ref = store.entityIndex.byId.get(valueId);
  if (!ref) return undefined;
  const entity = extractor.extractEntity(ref);
  if (!entity) return undefined;
  if (entity.type.toUpperCase() !== 'IFCCOSTVALUE') return undefined;
  const a = entity.attributes || [];

  visiting.add(valueId);
  const componentIds = asRefList(a[COST_VALUE_ATTR.Components]);
  const components = componentIds.length
    ? componentIds
        .map((id) => extractCostValue(extractor, store, id, depth + 1, visiting))
        .filter((c): c is CostValueInfo => c !== undefined)
    : undefined;
  visiting.delete(valueId);

  return {
    name: asString(a[COST_VALUE_ATTR.Name]),
    description: asString(a[COST_VALUE_ATTR.Description]),
    appliedValue: asAppliedValueNumber(a[COST_VALUE_ATTR.AppliedValue]),
    applicableDate: asString(a[COST_VALUE_ATTR.ApplicableDate]),
    fixedUntilDate: asString(a[COST_VALUE_ATTR.FixedUntilDate]),
    category: asString(a[COST_VALUE_ATTR.Category]),
    condition: asString(a[COST_VALUE_ATTR.Condition]),
    arithmeticOperator: asEnum(a[COST_VALUE_ATTR.ArithmeticOperator]),
    ...(components && components.length ? { components } : {}),
  };
}

function extractCostValues(
  extractor: EntityExtractor,
  store: IfcDataStore,
  refs: unknown,
): CostValueInfo[] | undefined {
  const ids = asRefList(refs);
  if (ids.length === 0) return undefined;
  const visiting = new Set<number>();
  const values = ids
    .map((id) => extractCostValue(extractor, store, id, 0, visiting))
    .filter((v): v is CostValueInfo => v !== undefined);
  return values.length ? values : undefined;
}

/**
 * Extract all costing data from a parsed IFC store.
 *
 * Walks every IfcCostItem / IfcCostSchedule / IfcRelNests /
 * IfcRelAssignsToControl entity and assembles a connected CostExtraction.
 */
export function extractCostOnDemand(store: IfcDataStore): CostExtraction {
  if (!store.source?.length) {
    return { costSchedules: [], costItems: [], hasCost: false };
  }

  const byType = store.entityIndex.byType;
  const costItemIds = byType.get('IFCCOSTITEM') ?? [];
  const costScheduleIds = byType.get('IFCCOSTSCHEDULE') ?? [];
  const relNestsIds = byType.get('IFCRELNESTS') ?? [];
  const relAssignsControlIds = byType.get('IFCRELASSIGNSTOCONTROL') ?? [];

  if (costItemIds.length + costScheduleIds.length === 0) {
    return { costSchedules: [], costItems: [], hasCost: false };
  }

  const extractor = new EntityExtractor(store.source);
  // IFC2X3's IfcCostItem has no attributes at all — schema-version-gated,
  // not inferred from a missing value (see module doc comment).
  const schemaIs2x3 = store.schemaVersion === 'IFC2X3';

  const costItemByExpressId = new Map<number, CostItemInfo>();

  // Pass 1: base IfcCostItem records.
  for (const expressId of costItemIds) {
    const ref = store.entityIndex.byId.get(expressId);
    if (!ref) continue;
    const entity = extractor.extractEntity(ref);
    if (!entity) continue;
    const a = entity.attributes || [];
    const globalId = asString(a[COST_ITEM_ATTR.GlobalId]) ?? '';

    const item: CostItemInfo = {
      expressId,
      globalId,
      name: asString(a[COST_ITEM_ATTR.Name]) ?? '',
      predefinedType: schemaIs2x3 ? undefined : asEnum(a[COST_ITEM_ATTR.PredefinedType]),
      costValues: schemaIs2x3
        ? undefined
        : extractCostValues(extractor, store, a[COST_ITEM_ATTR.CostValues]),
      costQuantities: schemaIs2x3
        ? undefined
        : (() => {
            const qtys = collectQuantitiesFromRefs(store, extractor, a[COST_ITEM_ATTR.CostQuantities]);
            return qtys.length ? qtys : undefined;
          })(),
      childGlobalIds: [],
      productExpressIds: [],
      productGlobalIds: [],
      controllingScheduleGlobalIds: [],
    };
    costItemByExpressId.set(expressId, item);
  }

  // Pass 2: IfcRelNests — cost item breakdown hierarchy.
  for (const relId of relNestsIds) {
    const ref = store.entityIndex.byId.get(relId);
    if (!ref) continue;
    const entity = extractor.extractEntity(ref);
    if (!entity) continue;
    const a = entity.attributes || [];
    const parent = asRef(a[REL_NESTS_ATTR.RelatingObject]);
    const children = asRefList(a[REL_NESTS_ATTR.RelatedObjects]);
    if (parent === undefined) continue;
    const parentItem = costItemByExpressId.get(parent);
    if (!parentItem) continue; // nesting over non-cost-item entities — ignore
    for (const childId of children) {
      const childItem = costItemByExpressId.get(childId);
      if (!childItem) continue;
      parentItem.childGlobalIds.push(childItem.globalId);
      if (!childItem.parentGlobalId) {
        childItem.parentGlobalId = parentItem.globalId;
      }
    }
  }

  // Pass 3: extract cost schedules.
  const costSchedules: CostScheduleInfo[] = [];
  const scheduleByExpressId = new Map<number, CostScheduleInfo>();
  for (const expressId of costScheduleIds) {
    const ref = store.entityIndex.byId.get(expressId);
    if (!ref) continue;
    const entity = extractor.extractEntity(ref);
    if (!entity) continue;
    const a = entity.attributes || [];
    const globalId = asString(a[COST_SCHEDULE_ATTR.GlobalId]) ?? '';
    const info: CostScheduleInfo = {
      expressId,
      globalId,
      name: asString(a[COST_SCHEDULE_ATTR.Name]) ?? '',
      predefinedType: schemaIs2x3 ? undefined : asEnum(a[COST_SCHEDULE_ATTR.PredefinedType]),
      status: schemaIs2x3 ? undefined : asString(a[COST_SCHEDULE_ATTR.Status]),
      submittedOn: schemaIs2x3 ? undefined : asString(a[COST_SCHEDULE_ATTR.SubmittedOn]),
      updateDate: schemaIs2x3 ? undefined : asString(a[COST_SCHEDULE_ATTR.UpdateDate]),
      costItemGlobalIds: [],
    };
    costSchedules.push(info);
    scheduleByExpressId.set(expressId, info);
  }

  // Pass 4: IfcRelAssignsToControl — schedule->cost-item assignment AND
  // cost-item->object (product) assignment, told apart by what
  // RelatingControl resolves to (see module doc comment).
  for (const relId of relAssignsControlIds) {
    const ref = store.entityIndex.byId.get(relId);
    if (!ref) continue;
    const entity = extractor.extractEntity(ref);
    if (!entity) continue;
    const a = entity.attributes || [];
    const controlId = asRef(a[REL_ASSIGNS_TO_CONTROL_ATTR.RelatingControl]);
    if (controlId === undefined) continue;
    const relatedIds = asRefList(a[REL_ASSIGNS_TO_CONTROL_ATTR.RelatedObjects]);

    const schedule = scheduleByExpressId.get(controlId);
    if (schedule) {
      for (const objId of relatedIds) {
        const item = costItemByExpressId.get(objId);
        if (!item) continue;
        schedule.costItemGlobalIds.push(item.globalId);
        item.controllingScheduleGlobalIds.push(schedule.globalId);
      }
      continue;
    }

    const costItem = costItemByExpressId.get(controlId);
    if (costItem) {
      for (const productId of relatedIds) {
        const gid = store.entities?.getGlobalId?.(productId) ?? undefined;
        costItem.productExpressIds.push(productId);
        costItem.productGlobalIds.push(gid ?? '');
      }
    }
  }

  return {
    costSchedules,
    costItems: Array.from(costItemByExpressId.values()),
    hasCost: true,
  };
}
