/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge schemas for the IFC 5D / cost `bim.create.*` methods (#4856).
 *
 * Kept in its own module for the same reason `bridge-create-schedule.ts` is:
 * `bridge-create.ts` sits on its recorded module-size budget. The four
 * relationship helpers share one `(number, number, number[])` shape and are
 * generated through a single factory rather than four copies of the same
 * block.
 */

import type { IfcCreator } from '@ifc-lite/sdk';
import type { MethodSchema, MethodSemanticContract } from './bridge-schema.js';
import { creatorRegistry } from './creator-registry.js';

/** Names of cost methods on IfcCreator that take a `(number, number[])` shape. */
type CostRelMethodName =
  | 'addIfcRelAssignsToProduct'
  | 'assignCostItemsToSchedule'
  | 'assignCostItemsToProduct'
  | 'assignTasksToCostItem'
  | 'nestCostItems';

/** Build a single `(number, number, number[]) → number` cost-relationship schema. */
function costRel(
  name: CostRelMethodName,
  paramNames: readonly [string, string, string],
  doc: string,
  llm: MethodSemanticContract,
): MethodSchema {
  return {
    name,
    doc,
    args: ['number', 'number', 'dump'],
    paramNames: [...paramNames],
    tsParamTypes: [undefined, undefined, 'number[]'],
    tsReturn: 'number',
    call: (_sdk, args, context) => {
      const creator = creatorRegistry.getForSession(context.sandboxSessionId, args[0] as number) as IfcCreator;
      const fn = (creator as unknown as Record<string, (a: number, b: number[]) => number>)[name];
      return fn.call(creator, args[1] as number, args[2] as number[]);
    },
    returns: 'value',
    llmSemantics: llm,
  };
}

const TYPED_VALUE_TS =
  "{ Type: 'IfcMonetaryMeasure' | 'IfcAreaMeasure' | 'IfcVolumeMeasure' | 'IfcLengthMeasure' | "
  + "'IfcMassMeasure' | 'IfcTimeMeasure' | 'IfcCountMeasure' | 'IfcNumericMeasure' | 'IfcRatioMeasure' | "
  + "'IfcReal' | 'IfcInteger'; Value: number }";

const COST_VALUE_TS =
  `{ Name?: string; Description?: string; AppliedValue?: ${TYPED_VALUE_TS}; AppliedValueRef?: number; `
  + 'UnitBasis?: number; ApplicableDate?: string; FixedUntilDate?: string; Category?: string; '
  + "Condition?: string; ArithmeticOperator?: 'ADD' | 'DIVIDE' | 'MULTIPLY' | 'SUBTRACT'; Components?: number[] }";

const COST_ITEM_TS =
  '{ Name: string; Description?: string; ObjectType?: string; Identification?: string; '
  + "PredefinedType?: 'USERDEFINED' | 'NOTDEFINED'; CostValues?: number[]; CostQuantities?: number[] }";

const COST_SCHEDULE_TS =
  '{ Name: string; Description?: string; ObjectType?: string; Identification?: string; '
  + "PredefinedType?: 'BUDGET' | 'COSTPLAN' | 'ESTIMATE' | 'TENDER' | 'PRICEDBILLOFQUANTITIES' | "
  + "'UNPRICEDBILLOFQUANTITIES' | 'SCHEDULEOFRATES' | 'USERDEFINED' | 'NOTDEFINED'; Status?: string; "
  + 'SubmittedOn?: string; UpdateDate?: string }';

const QUANTITY_TS =
  "{ Kind: 'IfcQuantityLength' | 'IfcQuantityArea' | 'IfcQuantityVolume' | 'IfcQuantityWeight' | "
  + "'IfcQuantityTime' | 'IfcQuantityCount' | 'IfcQuantityNumber'; Name: string; Value: number; "
  + 'Description?: string; Unit?: number; Formula?: string }';

const SI_UNIT_TS =
  "{ UnitType: 'LENGTHUNIT' | 'AREAUNIT' | 'VOLUMEUNIT' | 'MASSUNIT' | 'TIMEUNIT'; "
  + 'Prefix?: string; Name: string }';

/**
 * Names of the cost methods that must live in `SPECIAL_METHODS` in
 * `bridge-create.ts` — exposed so the two files stay in sync.
 */
export const COST_SPECIAL_METHOD_NAMES = [
  'addIfcCostSchedule', 'addIfcCostItem', 'addIfcCostValue',
  'addIfcMonetaryUnit', 'addIfcSIUnit', 'addIfcMeasureWithUnit', 'addIfcPhysicalQuantity',
  'addIfcRelAssignsToProduct', 'assignCostItemsToSchedule', 'assignCostItemsToProduct',
  'assignTasksToCostItem', 'nestCostItems',
] as const;

/** Build every IFC 5D / cost method schema. Consumed by `buildCreateMethods()`. */
export function buildCostMethods(): MethodSchema[] {
  const methods: MethodSchema[] = [];

  const paramsMethod = (
    name: 'addIfcCostSchedule' | 'addIfcCostItem' | 'addIfcCostValue' | 'addIfcSIUnit'
      | 'addIfcPhysicalQuantity',
    doc: string,
    tsParams: string,
    llm: MethodSemanticContract,
  ): void => {
    methods.push({
      name,
      doc,
      args: ['number', 'dump'],
      paramNames: ['handle', 'params'],
      tsParamTypes: [undefined, tsParams],
      tsReturn: 'number',
      call: (_sdk, args, context) => {
        const creator = creatorRegistry.getForSession(context.sandboxSessionId, args[0] as number) as IfcCreator;
        const fn = (creator as unknown as Record<string, (p: unknown) => number>)[name];
        return fn.call(creator, args[1]);
      },
      returns: 'value',
      llmSemantics: llm,
    });
  };

  paramsMethod('addIfcCostSchedule',
    'Create an IfcCostSchedule (IFC4 / IFC4X3 only). Returns schedule expressId.',
    COST_SCHEDULE_TS, {
      taskTags: ['create'],
      requiredKeys: ['Name'],
      useWhen: 'Create the cost schedule container first, then put root cost items under it with assignCostItemsToSchedule.',
      cautions: ['Cost authoring is refused on IFC2X3 — create the model with Schema "IFC4" or "IFC4X3".'],
    });

  paramsMethod('addIfcCostItem',
    'Create an IfcCostItem (IFC4 / IFC4X3 only). Returns cost item expressId.',
    COST_ITEM_TS, {
      taskTags: ['create'],
      requiredKeys: ['Name'],
      useWhen: 'One line of a cost breakdown. Pass CostValues / CostQuantities as expressIds from addIfcCostValue / addIfcPhysicalQuantity.',
      cautions: [
        'Omit CostValues / CostQuantities entirely for "no value" — an EMPTY array is refused, not treated as absent.',
        'Build the hierarchy with nestCostItems(parentId, childIds), not by nesting the params.',
      ],
    });

  paramsMethod('addIfcCostValue',
    'Create an IfcCostValue (IFC4 / IFC4X3 only). Returns cost value expressId.',
    COST_VALUE_TS, {
      taskTags: ['create'],
      requiredKeys: [],
      useWhen: 'A rate or amount. AppliedValue is a TYPED measure: { Type: "IfcMonetaryMeasure", Value: 1234.56 }.',
      cautions: [
        'AppliedValue and AppliedValueRef are two branches of one SELECT — pass at most one.',
        'A value computed from Components must NOT also carry an AppliedValue: keep whichever form the source used.',
        'UnitBasis is the quantity the rate is quoted PER (e.g. 100 m²). It divides — an invented one is an order-of-magnitude error.',
      ],
    });

  paramsMethod('addIfcSIUnit',
    'Create an IfcSIUnit for use as a quantity or measure unit. Returns unit expressId.',
    SI_UNIT_TS, {
      taskTags: ['create'],
      requiredKeys: ['UnitType', 'Name'],
      useWhen: 'Create the unit ONCE and reuse its expressId — shared references keep the file small and the rates consistent.',
    });

  paramsMethod('addIfcPhysicalQuantity',
    'Create an IfcPhysicalSimpleQuantity for IfcCostItem.CostQuantities. Returns quantity expressId.',
    QUANTITY_TS, {
      taskTags: ['create'],
      requiredKeys: ['Kind', 'Name', 'Value'],
      useWhen: 'The measured quantity a cost item is priced against. Value is a plain number; Unit is an expressId from addIfcSIUnit.',
    });

  methods.push({
    name: 'addIfcMonetaryUnit',
    doc: 'Create an IfcMonetaryUnit for a currency code. Returns unit expressId.',
    args: ['number', 'string'],
    paramNames: ['handle', 'currency'],
    tsParamTypes: [undefined, 'string'],
    tsReturn: 'number',
    call: (_sdk, args, context) => {
      const creator = creatorRegistry.getForSession(context.sandboxSessionId, args[0] as number) as IfcCreator;
      return creator.addIfcMonetaryUnit(args[1] as string);
    },
    returns: 'value',
    llmSemantics: {
      taskTags: ['create'],
      requiredKeys: [],
      useWhen: 'Only when the source states a currency. For the PROJECT currency pass Currency to bim.create.project instead.',
      cautions: ['There is no default currency. If the source does not state one, do not invent one — leave it out.'],
    },
  });

  methods.push({
    name: 'addIfcMeasureWithUnit',
    doc: 'Create an IfcMeasureWithUnit (a typed value paired with a unit). Returns its expressId.',
    args: ['number', 'dump', 'number'],
    paramNames: ['handle', 'value', 'unitId'],
    tsParamTypes: [undefined, TYPED_VALUE_TS, 'number'],
    tsReturn: 'number',
    call: (_sdk, args, context) => {
      const creator = creatorRegistry.getForSession(context.sandboxSessionId, args[0] as number) as IfcCreator;
      return creator.addIfcMeasureWithUnit(
        args[1] as Parameters<typeof creator.addIfcMeasureWithUnit>[0], args[2] as number);
    },
    returns: 'value',
    llmSemantics: {
      taskTags: ['create'],
      requiredKeys: [],
      useWhen: 'Build the UnitBasis of a rate — e.g. { Type: "IfcAreaMeasure", Value: 100 } with an AREAUNIT for a rate per 100 m².',
      cautions: ['Reuse ONE measure expressId across every value quoted on the same basis rather than creating a copy per value.'],
    },
  });

  methods.push(costRel('assignCostItemsToSchedule', ['handle', 'scheduleId', 'costItemIds'],
    'Assign cost items to an IfcCostSchedule. Returns relationship expressId.', {
      taskTags: ['create'],
      requiredKeys: [],
      useWhen: 'Bind the ROOT cost items to the schedule; nested children reach it through nestCostItems.',
    }));

  methods.push(costRel('assignCostItemsToProduct', ['handle', 'productId', 'costItemIds'],
    'Assign cost items to the product they price. Returns relationship expressId.', {
      taskTags: ['create'],
      requiredKeys: [],
      useWhen: 'Link a cost item to the wall/slab/element it prices. The PRODUCT comes first, the cost items second.',
      cautions: ['The direction is not symmetric — swapping the arguments writes a relationship that parses and means the opposite.'],
    }));

  methods.push(costRel('assignTasksToCostItem', ['handle', 'costItemId', 'taskIds'],
    'Assign tasks to a cost item (an IfcCostItem is an IfcControl). Returns relationship expressId.', {
      taskTags: ['create'],
      requiredKeys: [],
      useWhen: 'Tie 5D cost to the 4D schedule: the cost item controls the tasks that incur it.',
    }));

  methods.push(costRel('nestCostItems', ['handle', 'parentCostItemId', 'childCostItemIds'],
    'Nest child cost items under a parent (IfcRelNests). Returns relationship expressId.', {
      taskTags: ['create'],
      requiredKeys: [],
      useWhen: 'Build the cost breakdown structure. The PARENT comes first.',
    }));

  methods.push(costRel('addIfcRelAssignsToProduct', ['handle', 'relatingProductId', 'relatedObjectIds'],
    'Canonical IfcRelAssignsToProduct. Prefer assignCostItemsToProduct.', {
      taskTags: ['create'],
      requiredKeys: [],
      useWhen: 'Use the canonical name when schema fidelity matters more than ergonomics.',
    }));

  return methods;
}
